/**
 * Bass/mid/treble split of the raw frequency bytes, shared by every preset that
 * reacts on three bands. Writes into `out` so the per-frame caller allocates
 * nothing.
 */
export function readBands(frequency: Uint8Array, out = { bass: 0, mid: 0, treble: 0 }) {
  let bass = 0, mid = 0, treble = 0
  const bassEnd = Math.floor(frequency.length * 0.1)
  const midEnd = Math.floor(frequency.length * 0.4)
  for (let i = 0; i < bassEnd; i++) bass += frequency[i]
  for (let i = bassEnd; i < midEnd; i++) mid += frequency[i]
  for (let i = midEnd; i < frequency.length; i++) treble += frequency[i]
  out.bass = bass / (bassEnd * 255)
  out.mid = mid / ((midEnd - bassEnd) * 255)
  out.treble = treble / ((frequency.length - midEnd) * 255)
  return out
}
