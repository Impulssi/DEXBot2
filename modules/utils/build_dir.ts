

import { path } from '../path_api';
const BUILD_DIR = 'dist';

function isDistRuntime(projectRoot: string): boolean {
  return path.basename(projectRoot) === BUILD_DIR;
}

export { BUILD_DIR, isDistRuntime }

