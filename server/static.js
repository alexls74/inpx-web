const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');
const execFile = require('util').promisify(require('child_process').execFile);

const express = require('express');
const utils = require('./core/utils');
const webAppDir = require('../build/appdir');

const log = new (require('./core/AppLogger'))().log;//singleton

//форматы, которые получаются конвертацией из fb2
//epub/mobi/azw3 - через fb2c (fb2converter), kfx - через fbc (fb2cng)
const CONVERT_TYPES = ['epub', 'mobi', 'azw3', 'kfx'];

//мусор, который конвертеры оставляют в рабочем каталоге
const CONVERTER_LOGS = ['conversion.log', 'fbc.log'];

function generateZip(zipFile, dataFile, dataFileInZip) {
    return new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        zip.addFile(dataFile, dataFileInZip);
        zip.outputStream
            .pipe(fs.createWriteStream(zipFile)).on('error', reject)
            .on('finish', (err) => {
                if (err) reject(err);
                else resolve();
            }
            );
        zip.end();
    });
}

function sanitizeFileName(input) {
    const translitMap = {
        'а': 'a', 'А': 'A',
        'б': 'b', 'Б': 'B',
        'в': 'v', 'В': 'V',
        'г': 'g', 'Г': 'G',
        'д': 'd', 'Д': 'D',
        'е': 'e', 'Е': 'E',
        'ё': 'e', 'Ё': 'E',
        'ж': 'zh', 'Ж': 'Zh',
        'з': 'z', 'З': 'Z',
        'и': 'i', 'И': 'I',
        'й': 'y', 'Й': 'Y',
        'к': 'k', 'К': 'K',
        'л': 'l', 'Л': 'L',
        'м': 'm', 'М': 'M',
        'н': 'n', 'Н': 'N',
        'о': 'o', 'О': 'O',
        'п': 'p', 'П': 'P',
        'р': 'r', 'Р': 'R',
        'с': 's', 'С': 'S',
        'т': 't', 'Т': 'T',
        'у': 'u', 'У': 'U',
        'ф': 'f', 'Ф': 'F',
        'х': 'h', 'Х': 'H',
        'ц': 'ts', 'Ц': 'Ts',
        'ч': 'ch', 'Ч': 'Ch',
        'ш': 'sh', 'Ш': 'Sh',
        'щ': 'shch', 'Щ': 'Shch',
        'ы': 'y', 'Ы': 'Y',
        'э': 'e', 'Э': 'E',
        'ю': 'yu', 'Ю': 'Yu',
        'я': 'ya', 'Я': 'Ya',
        'ь': '', 'Ь': '',
        'ъ': '', 'Ъ': ''
    };

    return input
        .split('')
        .map(char => translitMap[char] ?? char)
        .join('')
        .replace(/\s+/g, '_')               // пробелы → _
        .replace(/\./g, '_')                // точки → _
        .replace(/[^a-zA-Z0-9_-]/g, '')     // убрать всё, кроме латиницы, цифр, подчёркивания, дефиса
        .replace(/_+/g, '_')                // несколько подчёркиваний → одно
        .replace(/^_+|_+$/g, '');           // обрезать подчёркивания по краям
}


module.exports = (app, config) => {

    config.bookPathStatic = `${config.rootPathStatic}/book`;
    config.bookDir = `${config.publicFilesDir}/book`;

    //загрузка или восстановление файлов в /public-files, при необходимости
    app.use([`${config.bookPathStatic}/:fileName/:fileType`, `${config.bookPathStatic}/:fileName`], async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
        }

        try {
            const fileName = req.params.fileName;
            const fileType = req.params.fileType;

            if (path.extname(fileName) === '') {//восстановление файлов {hash}.raw, {hash}.zip
                let bookFile = `${config.bookDir}/${fileName}`;
                const bookFileDesc = `${bookFile}.d.json`;

                //восстановим из json-файла описания
                if (await fs.pathExists(bookFile) && await fs.pathExists(bookFileDesc)) {
                    await utils.touchFile(bookFile);
                    await utils.touchFile(bookFileDesc);

                    let desc = await fs.readFile(bookFileDesc, 'utf8');
                    let downFileName = (JSON.parse(desc)).downFileName;
                    let gzipped = true;

                    //Fix downFileName extention for a file converted from fb2

                    if (CONVERT_TYPES.includes(fileType)) {
                        downFileName = downFileName.replace(/fb2$/, fileType);

                    }

                    if (!req.acceptsEncodings('gzip') || fileType) {
                        const rawFile = `${bookFile}.raw`;
                        //не принимает gzip, тогда распакуем
                        if (!await fs.pathExists(rawFile))
                            await utils.gunzipFile(bookFile, rawFile);

                        gzipped = false;

                        if (fileType === undefined || fileType === 'raw') {
                            bookFile = rawFile;
                        } else if (CONVERT_TYPES.includes(fileType)) {
                            //перекодируем файл в нужный формат
                            bookFile += `.${fileType}`;
                            if (!await fs.pathExists(bookFile)) {
                                const fb2File = path.resolve(rawFile.replace(/raw$/, 'fb2'));
                                await fs.copyFile(rawFile, fb2File);

                                let bin = '';
                                let args = [];

                                if (fileType === 'kfx') {
                                    //fb2cng: умеет kfx напрямую, без kindlegen
                                    if (!config.fbc)
                                        throw new Error('fbc path is not configured');

                                    bin = config.fbc;
                                    if (config.fbc_conf)
                                        args.push('-c', config.fbc_conf);
                                    //--output-file задает точный путь результата,
                                    //output_name_template при этом игнорируется
                                    args.push(
                                        'convert', '--to', 'kfx', '--overwrite',
                                        '-o', path.resolve(bookFile), fb2File
                                    );
                                } else {
                                    //fb2converter: epub/mobi/azw3
                                    if (!config.fb2c)
                                        throw new Error('fb2c path is not configured');

                                    bin = config.fb2c;
                                    if (config.fb2c_conf)
                                        args.push('-c', config.fb2c_conf);
                                    args.push(
                                        'convert', '--to', fileType, '--nodirs', '--overwrite', fb2File
                                    );
                                }

                                await execFile(bin, args, {cwd: path.dirname(fb2File)});
                            }
                        } else if (fileType === 'zip') {
                            //создаем zip-файл
                            bookFile += '.zip';
                            if (!await fs.pathExists(bookFile))
                                await generateZip(bookFile, rawFile, downFileName);
                            downFileName += '.zip';
                        } else {
                            throw new Error(`Unsupported file type: ${fileType}`);
                        }
                    }

                    //отдача файла

                    // const ext = path.extname(downFileName);
                    // const baseName = path.basename(downFileName, ext);
                    // const safeName = sanitizeFileName(baseName) + ext;

                    // if (gzipped)
                    //     res.set('Content-Encoding', 'gzip');
                    //     res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`);
                    //     res.sendFile(path.resolve(bookFile));
                    // return;

                    const ext = path.extname(downFileName);
                    const baseName = path.basename(downFileName, ext); // для имени в Content-Disposition
                    const safeName = sanitizeFileName(baseName) + ext;

                    const fullPath = path.resolve(bookFile); // файл с хеш-именем
                    const realBase = path.basename(bookFile).replace(path.extname(bookFile), ''); // ХЕШ

                    // if (gzipped)
                    //     res.set('Content-Encoding', 'gzip');
                    // res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`);

                    // res.sendFile(fullPath, async (err) => {
                    if (gzipped)
                        res.set('Content-Encoding', 'gzip');

                    const disposition = (fileType && fileType !== 'raw') ? 'attachment' : 'inline';
                    res.set('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(safeName)}`);

                    res.sendFile(fullPath, async (err) => {

                        if (err) {
                            console.error('Ошибка при отправке файла:', err);
                            return;
                        }

                        try {
                            const dir = path.dirname(fullPath);
                            const allFiles = await fs.readdir(dir);

                            for (const file of allFiles) {
                                if (
                                    CONVERTER_LOGS.includes(file) ||
                                    file.startsWith(realBase + '.') ||
                                    file === realBase
                                ) {
                                    await fs.remove(path.join(dir, file));
                                    console.log(`Удалён: ${file}`);
                                }
                            }

                            console.log(`Временные файлы для -=${baseName}=- удалены.`);
                        } catch (e) {
                            console.error('Ошибка при удалении временных файлов:', e);
                        }
                    });
                    return;


                } else {
                    await fs.remove(bookFile);
                    await fs.remove(bookFileDesc);
                }
            }
        } catch (e) {
            log(LM_ERR, e.message);
        }

        return next();
    });

    //иначе просто отдаем запрошенный файл из /public-files
    app.use(config.bookPathStatic, express.static(config.bookDir));

    if (config.rootPathStatic) {
        //подмена rootPath в файлах статики WebApp при необходимости
        app.use(config.rootPathStatic, async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                return next();
            }

            try {
                const reqPath = (req.path == '/' ? '/index.html' : req.path);
                const ext = path.extname(reqPath);
                if (ext == '.html' || ext == '.js' || ext == '.css') {
                    const reqFile = `${config.publicDir}${reqPath}`;
                    const flagFile = `${reqFile}.replaced`;

                    if (!await fs.pathExists(flagFile) && await fs.pathExists(reqFile)) {
                        const content = await fs.readFile(reqFile, 'utf8');
                        const re = new RegExp(`/${webAppDir}`, 'g');
                        await fs.writeFile(reqFile, content.replace(re, `${config.rootPathStatic}/${webAppDir}`));
                        await fs.writeFile(flagFile, '');
                    }
                }
            } catch (e) {
                log(LM_ERR, e.message);
            }

            return next();
        });
    }

    //статика файлов WebApp
    app.use(config.rootPathStatic, express.static(config.publicDir));
};