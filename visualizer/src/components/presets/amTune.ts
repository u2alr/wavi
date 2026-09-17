/**
 * Tuning for the AM presets, so each behavior has a named control instead of a
 * magic number in the shader. Defaults reproduce WaveformPreset 1:1 (follow 1,
 * mirror off, gain 1).
 */
export const AM_TUNE = {
  follow: 2,         // refresh blend; 1 = raw sample, exactly like Waveform
  ampQuiet: 0.01,    // amplitude floor at silence
  ampEnergy: 0.55,   // amplitude added at full bass
  thickMin: 0.002,   // stroke width at silence
  thickEnergy: 0.002, // stroke width added at full bass
  spacing: 0.001,    // derivative sampling step (thick-stroke consistency)
  soft: 0.00008,       // smoothstep AA shoulder
  gain: 1,           // master amplitude multiplier
  mirror: true,     // true = symmetric mirror trace, false = Waveform look
}
