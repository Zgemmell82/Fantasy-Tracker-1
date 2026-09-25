// Everything is saved on the device, under the same keys the design used.
export const LS = 'ff-tracker-v3';
export const LS_PL = 'ff-sleeper-players';

export function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
