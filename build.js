const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const publicDir = path.join(__dirname, 'public');
// The application page is built into /app; public/index.html is the hand-written
// public landing page served at / (see tests/test_build_artifact.mjs).
const appDir = path.join(publicDir, 'app');

// Ensure public directory exists
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
}

function processIncludes(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Match <?!= include('FileName'); ?> or <?!= include("FileName") ?> or <?= include('FileName') ?>
    const includeRegex = /<\?!=?\s*include\(['"]([^'"]+)['"]\);?\s*\?>/g;
    
    content = content.replace(includeRegex, (match, fileName) => {
        // GAS includes omit the .html extension
        const includePath = path.join(srcDir, `${fileName}.html`);
        if (fs.existsSync(includePath)) {
            console.log(`Inlining ${fileName}.html...`);
            return processIncludes(includePath);
        } else {
            console.warn(`WARNING: Included file not found: ${includePath}`);
            return match;
        }
    });
    
    return content;
}

const sourceIndex = path.join(srcDir, 'Index.html');
if (fs.existsSync(sourceIndex)) {
    console.log('Building app page...');
    let finalHtml = processIncludes(sourceIndex);
    
    // Inject Cloudflare shim for google.script.run
    const shimScript = '\n  <script src="/cloudflare-shim.js"></script>\n</head>';
    finalHtml = finalHtml.replace('</head>', shimScript);

    fs.writeFileSync(path.join(appDir, 'index.html'), finalHtml);
    console.log('Build complete: public/app/index.html');

    // public/index.html is the public landing page at / and is NOT generated.
    // Cloudflare Pages would serve a directory listing (or 404) without it.
    if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
        console.warn('WARNING: public/index.html (landing page for /) is missing — / will not render.');
    }
} else {
    console.error('src/Index.html not found!');
}
