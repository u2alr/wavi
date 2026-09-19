/**
 * The scalar helpers the preset shaders carry in GLSL, mirrored once on the CPU.
 *
 * Why these exist. Every preset is a full-screen fragment shader, so anything
 * that depends only on a uniform — a hue, a band level, a smoothstep gate — is
 * the same value for all 1.2M pixels, yet a shader evaluates it per pixel per
 * frame. Moving that work into the component and uploading the result as a
 * uniform is free look-wise (it is the same arithmetic) and measurably cheaper:
 * on AcidWash it took 13.5% off the frame (0.426ms -> 0.368ms at 1568x765 on an
 * RX 6600 XT) with the output identical to within a single 1/255 step on 6 of
 * 1.2M pixels, which is the driver's own run-to-run noise.
 *
 * These are line-for-line mirrors of the shader versions, including the details
 * that are easy to get subtly wrong: `fract` must stay positive for negative
 * inputs, and `smoothstep`'s clamp is what makes it flat outside its edges.
 */

/** GLSL `fract`: the positive fractional part. */
export const fract = (x: number): number => x - Math.floor(x)

/** GLSL `clamp(x, 0.0, 1.0)`. */
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * The presets' `hsv2rgb`, for colours that depend only on a uniform:
 *
 *   vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
 *   vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
 *   return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
 */
export function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  // K.x/y/z name the three channels; K.w is the 3.0 subtracted from each.
  const channel = (k: number): number => v * (1 + s * (clamp01(Math.abs(fract(h + k) * 6 - 3) - 1) - 1))
  return [channel(1), channel(2 / 3), channel(1 / 3)]
}
