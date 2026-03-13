#!/usr/bin/env node

/**
 * Web Build Script
 *
 * Builds the static-site version of Markdown Viewer.
 * Output: dist/web/  (deployable to GitHub Pages or any static host)
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return [];

  const toCopy = [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const sourcePath = path.join(sourceDir, entryName);
    const targetPath = path.join(targetDir, entryName);

    const isDirectory =
      typeof entry === 'object' && typeof entry.isDirectory === 'function'
        ? entry.isDirectory()
        : fs.statSync(sourcePath).isDirectory();

    if (isDirectory) {
      toCopy.push(...copyDirectory(sourcePath, targetPath));
    } else {
      toCopy.push({ src: sourcePath, dest: targetPath });
    }
  }

  return toCopy;
}

function copyFileIfExists(sourcePath, targetPath, logMessage) {
  if (!fs.existsSync(sourcePath)) return false;

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.copyFileSync(sourcePath, targetPath);
  if (logMessage) console.log(logMessage);
  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
);
const version = packageJson.version;

console.log(`🔨 Building Web Viewer... v${version}\n`);

try {
  const outdir = path.join(projectRoot, 'dist/web');

  // Clean previous build
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }

  // Change to project root for esbuild to resolve correctly
  process.chdir(projectRoot);

  await build({
    entryPoints: {
      'core/main': 'web/src/webview/main.ts',
      'core/render-worker-page': 'web/src/webview/render-worker-page.ts',
      'ui/styles': 'src/ui/styles.css',
    },
    bundle: true,
    outdir: 'dist/web',
    format: 'iife',
    target: ['es2020'],
    treeShaking: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'globalThis',
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css',
      '.woff2': 'file',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty',
    },
    assetNames: '[name]',
    external: ['mermaid'],
    minify: true,
    sourcemap: false,
    plugins: [
      {
        name: 'copy-web-assets',
        setup(build) {
          build.onEnd(() => {
            try {
              const fileCopies = [];

              // Static HTML pages
              fileCopies.push({ src: 'web/index.html',          dest: 'dist/web/index.html' });
              fileCopies.push({ src: 'web/render-worker.html',  dest: 'dist/web/render-worker.html' });
              fileCopies.push({ src: 'web/web.css',             dest: 'dist/web/web.css' });

              // Shared resources
              fileCopies.push(...copyDirectory('icons',       'dist/web/icons'));
              fileCopies.push(...copyDirectory('src/_locales','dist/web/_locales'));
              fileCopies.push(...copyDirectory('src/themes',  'dist/web/themes'));
              fileCopies.push(
                ...copyDirectory(
                  'node_modules/@markdown-viewer/drawio2svg/resources/stencils',
                  'dist/web/stencils',
                ),
              );

              // Mermaid library
              fileCopies.push({
                src: 'node_modules/mermaid/dist/mermaid.min.js',
                dest: 'dist/web/libs/mermaid.min.js',
                log: '📦 Copied libs/mermaid.min.js',
              });

              fileCopies.forEach(({ src, dest, log }) => copyFileIfExists(src, dest, log));

              // Fix KaTeX font paths – esbuild may emit ./ or ../ prefixes;
              // normalise both to ../ so fonts resolve from dist/web/ root.
              const stylesCss = 'dist/web/ui/styles.css';
              if (fs.existsSync(stylesCss)) {
                let content = fs.readFileSync(stylesCss, 'utf8');
                content = content.replace(
                  /url\("\.\.?\/KaTeX_([^"]+)"\)/g,
                  'url("../KaTeX_$1")',
                );
                fs.writeFileSync(stylesCss, content);
                console.log('📄 Fixed font paths in styles.css');
              }

              // Copy LICENSE
              copyFileIfExists('LICENSE', 'dist/web/LICENSE');

              console.log('✅ Web assets copied to dist/web/');
            } catch (error) {
              console.error('Error copying web assets:', error.message);
            }
          });
        },
      },
    ],
  });

  console.log(`\n✅ Build complete!`);
  console.log(`   Output: dist/web/`);
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
