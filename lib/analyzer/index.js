const request = require('request');
const fileType = require('file-type');
const URI = require('urijs');
const Promise = require('bluebird');
const { pick, get } = require('lodash');
const { strRightBack } = require('underscore.string');
const parseContentDisposition = require('content-disposition').parse;
const fs = require('fs');
const { dir } = require('tmp');
const { exec } = require('child_process');
const findit = require('findit');
const crypto = require('crypto');
const rimraf = require('rimraf');
const through2 = require('through2');

const tmpDirAsync = Promise.promisify(dir, { multiArgs: true });
const execAsync = Promise.promisify(exec);
const rimrafAsync = Promise.promisify(rimraf);

const getExtension = fileName => {
  if (fileName && fileName.includes('.')) {
    return strRightBack(fileName, '.');
  } else {
    return undefined;
  }
};

const BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'application/binary',
];

const ARCHIVE_EXTENSIONS = [
  'zip',
  'tar',
  'rar',
  'gz',
  'bz2',
  '7z',
  'xz',
];

class Analyzer {

  constructor(location, options = {}) {
    this.rawLocation = location;
    this.location = new URI(location);
    this.options = {
      fileTypeDetection: true,
      abort: 'always',
    };
    Object.assign(this.options, options);
  }

  executeRequest() {
    return new Promise((resolve, reject) => {
      this.req = request
      .get(this.rawLocation)
      .on('error', reject)
      .on('response', response => {
        this.response = response;
        this.response.pause();
        resolve(this);
      });
    });
  }

  extractDataFromResponse() {
    Object.assign(this, pick(this.response, 'statusCode', 'headers'));
    if (this.response.headers['content-disposition']) {
      this.contentDisposition = parseContentDisposition(this.response.headers['content-disposition']);
    }
    return this;
  }

  extractFileTypeFromMagicNumber() {
    if (!this.options.fileTypeDetection) return this;
    return new Promise((resolve, reject) => {
      this.response.once('data', chunk => {
        this.fileType = fileType(chunk);
        this.firstChunk = chunk;
        this.response.pause();
        resolve(this);
      });
      this.response.resume();
      setTimeout(() => reject(new Error('Timeout')), 5000);
    });
  }

  closeConnection(force = false) {
    if (this.options.abort === 'always' || force) {
      this.response.destroy();
      this.firstChunk = undefined;
    }
    return this;
  }

  inspect() {
    return this.executeRequest()
    .then(() => this.extractDataFromResponse())
    .then(() => this.extractFileTypeFromMagicNumber())
    .then(() => this.closeConnection());
  }

  get fileName() {
    return get(this, 'contentDisposition.parameters.filename') || this.location.filename(true);
  }

  get fileTypeExtension() {
    return get(this, 'fileType.ext');
  }

  get fileExtension() {
    let attachmentExt = getExtension(get(this, 'contentDisposition.parameters.filename'));
    let urlExt = getExtension(this.location.filename(true));
    return attachmentExt || urlExt || this.fileTypeExtension;
  }

  get binary() {
    let contentType = this.headers['content-type'];
    if (contentType && BINARY_CONTENT_TYPES.includes(contentType)) return true;
  }

  get archive() {
    if (ARCHIVE_EXTENSIONS.includes(this.fileTypeExtension)) {
      return this.fileTypeExtension;
    } else {
      return false;
    }
  }

  pipeWithResponse(destination) {
    this.destination = destination;
    this.response.pipe(destination);
    destination.write(this.firstChunk);
    this.response.resume();
    return destination;
  }

  toObject() {
    return pick(this, 'statusCode', 'headers', 'fileType', 'contentDisposition', 'fileName', 'fileExtension', 'binary', 'archive');
  }

  isArchive() {
    return (this.archive === 'zip' && this.fileExtension === 'zip') || (this.archive === 'rar' && this.fileExtension === 'rar');
  }

  createTempDirectory() {
    return tmpDirAsync({ prefix: 'plunger_', keep: true })
    .then(tmpDirResult => {
      this.tempDirectoryPath = tmpDirResult[0];
      return this.tempDirectoryPath;
    });
  }

  saveArchive() {
    return this.createTempDirectory()
    .then(path => {
      return new Promise((resolve, reject) => {
        this.archivePath = path + '/archive.' + this.archive;

        const hash = crypto.createHash('sha1');
        let readBytes = 0;

        this
        .pipeWithResponse(through2.obj((chunk, enc, cb) => {
          readBytes += chunk.length;
          if (readBytes > 100 * 1024 * 1204) {
            this.closeConnection(true);
            reject(new Error('Archive is too large'));
          }
          cb();
        }))
        .once('finish', () => this.readBytes = readBytes);

        this
        .pipeWithResponse(hash)
        .once('finish', () => this.digest = hash.read());

        this
        .pipeWithResponse(fs.createWriteStream(this.archivePath))
        .once('finish', () => resolve(this.archivePath))
        .on('error', reject);
      });
    });
  }

  decompressArchive() {
    if (this.decompressedDirectoryPath) return Promise.resolve(this.decompressedDirectoryPath);
    if (!this.archivePath) return Promise.reject(new Error('`archivePath` is not defined'));
    let decompressProcess;
    if (this.archive === 'zip') {
      decompressProcess = new Promise((resolve, reject) => {
        exec('unzip -d decompressed archive.zip', { cwd: this.tempDirectoryPath }, err => {
          if ((err && err.code === 1) || !err) return resolve();
          reject(err);
        });
      });
    }
    if (this.archive === 'rar') decompressProcess = execAsync('unrar x archive.rar decompressed/', { cwd: this.tempDirectoryPath });
    if (decompressProcess) {
      return decompressProcess.then(() => {
        this.decompressedDirectoryPath = this.tempDirectoryPath + '/decompressed';
        return this.decompressedDirectoryPath;
      });
    } else {
      return Promise.reject('Archive type not supported: ' + this.archive);
    }
  }

  listFiles() {
    if (!this.decompressedDirectoryPath) return Promise.reject(new Error('No iterable path found'));
    const startPoint = this.decompressedDirectoryPath.length + 1;
    const paths = [];
    const datasets = [];
    return new Promise((resolve, reject) => {
      findit(this.decompressedDirectoryPath)
      .on('file', file => {
        let shortFileName = file.substring(startPoint);
        paths.push(shortFileName);
        if (shortFileName.match(/\.(shp|tab|mif)$/i)) datasets.push(shortFileName);
      })
      .on('end', () => resolve({ all: paths, datasets: datasets }))
      .on('error', reject);
    });
  }

  cleanup() {
    if (this.tempDirectoryPath) {
      return rimrafAsync(this.tempDirectoryPath)
      .then(() => this.tempDirectoryPath = undefined);
    }
  }

}

module.exports = Analyzer;