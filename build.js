const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const publicDir = path.join(__dirname, 'public');

// Ensure public directory exists
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
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
    console.log('Building index.html...');
    let finalHtml = processIncludes(sourceIndex);
    
    // Inject Cloudflare shim for google.script.run
    const shimScript = '\n  <script src="/cloudflare-shim.js"></script>\n</head>';
    finalHtml = finalHtml.replace('</head>', shimScript);

    fs.writeFileSync(path.join(publicDir, 'index.html'), finalHtml);
    console.log('Build complete: public/index.html');
} else {
    console.error('src/Index.html not found!');
}
