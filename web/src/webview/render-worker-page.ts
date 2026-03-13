// Web Render Worker – iframe entry point
// Communicates with the parent page via window.postMessage

// Send ready message immediately before any imports fail
try {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'RENDER_FRAME_READY' }, '*');
  }
} catch {
  // Ignore errors
}

import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { WindowPostMessageTransport } from '../../../src/messaging/transports/window-postmessage-transport';
import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { DirectResourceService } from '../../../src/services/resource-service';

// Provide a minimal platform for services that call globalThis.platform.resource
globalThis.platform = {
  resource: new DirectResourceService((path) => `./${path}`),
} as unknown as typeof globalThis.platform;

type ReadyAckMessage = { type?: string };

function initialize(): void {
  let isReady = false;
  let readyAcknowledged = false;
  let readyInterval: ReturnType<typeof setInterval> | null = null;

  const renderChannel = new RenderChannel(
    new WindowPostMessageTransport(window.parent, {
      targetOrigin: '*',
      acceptSource: window.parent,
    }),
    {
      source: 'web-iframe-render',
      timeoutMs: 60_000,
    },
  );

  const worker = bootstrapRenderWorker(renderChannel, {
    getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
    getReady: () => isReady,
  });

  window.addEventListener('message', (event: MessageEvent<ReadyAckMessage>) => {
    const message = event.data;
    if (message && (message.type === 'READY_ACK')) {
      readyAcknowledged = true;
      if (readyInterval) {
        clearInterval(readyInterval);
        readyInterval = null;
      }
    }
  });

  const sendReady = (): void => {
    if (readyAcknowledged) return;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'RENDER_FRAME_READY' }, '*');
      }
    } catch {
      // Ignore errors
    }
  };

  worker.init();
  isReady = true;

  sendReady();
  readyInterval = setInterval(sendReady, 100);

  // Stop polling after 10 s
  setTimeout(() => {
    if (readyInterval) {
      clearInterval(readyInterval);
      readyInterval = null;
    }
  }, 10_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
