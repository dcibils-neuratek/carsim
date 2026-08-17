// Making the hand-written shaders survive being rendered off-canvas.
//
// three converts a colour to sRGB inside the fragment shader, via the
// <colorspace_fragment> chunk that every built-in material includes. A custom
// ShaderMaterial that writes gl_FragColor itself gets no such chunk and writes
// its colours out raw -- which, drawing straight to the canvas, means the sky,
// the skid marks and the tyre smoke have always been displayed as if their
// linear values were already display values. Darker than the palette says, and
// tuned by eye against that, so it is the look the game has.
//
// It only became a problem when a post chain arrived. A composer renders into
// a LINEAR target and something at the end encodes the whole image, so those
// three shaders suddenly got the conversion they never had: measured on
// Forest, the sky went from (12,51,114) to (62,123,178) the moment any effect
// was switched on. An effect toggle must not repaint the sky.
//
// So each of them declares where it is drawing, and pre-cancels the encode
// when it is drawing into a linear target. Same pixels either way.
//
// The exact sRGB transfer function rather than pow(2.2): the encode being
// undone is the exact one, and 2.2 leaves a visible error in the darks, which
// is most of a night sky.

/**
 * 1 while a composer is in the chain, 0 when drawing to the canvas.
 * Shared by reference -- assign this object into a ShaderMaterial's uniforms
 * and the post stack can flip every one of them with a single write.
 */
export const TARGET_IS_LINEAR = { value: 0 };

/** Paste into a fragment shader, then wrap the final colour in vroomOutput(). */
export const OUTPUT_GLSL = /* glsl */`
uniform float uTargetIsLinear;
vec3 vroomOutput(vec3 c) {
  if (uTargetIsLinear != 1.0) return c;
  vec3 lo = c / 12.92;
  vec3 hi = pow((max(c, 0.0) + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}`;

/** Add the uniform to a ShaderMaterial's uniform block. */
export function withOutputUniform(uniforms) {
  return { ...uniforms, uTargetIsLinear: TARGET_IS_LINEAR };
}
