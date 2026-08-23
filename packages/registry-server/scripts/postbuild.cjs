const fs = require('fs');
const path = require('path');

const distFile = path.join(__dirname, '..', 'dist', 'index.js');
let content = fs.readFileSync(distFile, 'utf8');
content = content.replace(' from "sqlite"', ' from "node:sqlite"');
fs.writeFileSync(distFile, content);
