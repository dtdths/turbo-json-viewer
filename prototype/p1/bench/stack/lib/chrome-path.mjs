import path from 'node:path';
export const REPO = path.resolve(import.meta.dirname, '../../../..'); // repo root
export const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../../fixtures/stack');
export const RESULTS_DIR = path.resolve(import.meta.dirname, '../results');
