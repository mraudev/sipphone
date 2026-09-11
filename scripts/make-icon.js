'use strict';
// Erzeugt assets/icon.png (512 px) und assets/icon.ico (16–256 px) aus assets/icon.svg.
// Aufruf: npm run icon
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ICO-Datei mit PNG-kodierten Einträgen
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  const svg = Buffer.from(fs.readFileSync(path.join(ASSETS, 'icon.svg'))).toString('base64');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const png = async (size) => {
    const url = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG konnte nicht geladen werden'));
      img.src = 'data:image/svg+xml;base64,${svg}';
    })`);
    return Buffer.from(url.split(',')[1], 'base64');
  };
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(512));
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, data: await png(size) });
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(images));
  console.log('assets/icon.png und assets/icon.ico erzeugt');
  app.quit();
});
