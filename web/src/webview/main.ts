// Markdown Viewer Main – Web Static Site Entry Point

import { platform } from './index';
import { startViewer } from './viewer-main';
import { createPluginRenderer } from '../../../src/core/viewer/viewer-host';

const pluginRenderer = createPluginRenderer(platform);

startViewer({
  platform,
  pluginRenderer,
  themeConfigRenderer: platform.renderer,
});
