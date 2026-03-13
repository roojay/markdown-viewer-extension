/**
 * Platform Entry Point
 *
 * Initializes and exports the web platform API instance.
 */

import { webPlatform } from './api-impl';

globalThis.platform = webPlatform;

export default webPlatform;
export { webPlatform as platform };
