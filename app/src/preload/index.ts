import { contextBridge } from 'electron';
import type { HoppBridge } from '../shared/bridge';

const bridge: HoppBridge = {
  version: '0',
};

contextBridge.exposeInMainWorld('hopp', bridge);
