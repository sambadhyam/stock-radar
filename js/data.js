// data.js — single place screens get their data from.
// Phase 0: returns the clearly labelled sample data. Phase 4 swaps this for the Apps Script API
// (with an offline cache), keeping the same shape so screens do not change.
import { demo } from './demo.js';

export function getData() {
  return demo;
}
