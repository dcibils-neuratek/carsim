// Track definitions.
//
// A track is pure data: a hand-laid centerline plus the palette, scenery and
// surface it's driven on. Everything else -- road mesh, collider, curbs,
// terrain, lap timing -- is derived from these by src/track.js, so adding a
// circuit means adding an entry here and nothing else.
//
// Laying out control points, two rules matter:
//   - No corner tighter than about 12 m radius. The road is swept as a ribbon,
//     and below (halfWidth + curbWidth) the inner edge folds through itself.
//   - Keep elevation changes gentle relative to their length. The terrain
//     heightfield has 5.6 m cells and has to stay under the asphalt.
// The autopilot lap test drives every track and fails on anything undriveable,
// so run the tests after editing a layout.

const BASE = {
  halfWidth: 6.0,
  curbWidth: 1.4,
  fog: { near: 260, far: 1150 },
  envSlope: 0.06,
  hills: { amplitude: 1.0, scale: 1.0 },
  // Superelevation. gain converts curvature (rad/m) into a cross-slope.
  // Superelevation. gain converts curvature (rad/m) into a cross-slope.
  // Keep maxDegrees modest: the wheel-height difference across the track is
  // halfTrack * tan(angle), and once that approaches the suspension travel the
  // car can no longer settle evenly on a banked surface.
  banking: { gain: 190, maxDegrees: 3.5 },
  surface: { roadGrip: 1.0, grassGrip: 0.45 },
  sun: { color: 0xfff3dd, intensity: 2.4, position: [70, 110, 45] },
  scenery: {
    treeCount: 620, treeHeight: [3.2, 6.6], treeRadius: [1.5, 2.4],
    treeSegments: 6, treeClearance: 16,
    ridgeCount: 64, ridgeHeight: [55, 200], ridgeRadius: 1150, ridgeJitter: 190,
    postSpacing: 12,
  },
};

export const TRACKS = {
  // ---------------------------------------------------------------- forest --
  forest: {
    id: 'forest',
    name: 'Forest',
    tagline: 'Fast sweepers, a chicane and a long hairpin',
    difficulty: 'Medium',
    palette: {
      sky: 0x74b6e8, skyHigh: 0x2f6ea8, horizon: 0xcfe6f5,
      ground: 0x5f9e4a, groundDark: 0x4a7f3a,
      asphalt: 0x3a3f47, asphaltEdge: 0x2b2f35,
      curbA: 0xd94141, curbB: 0xf2f2f2,
      ridge: 0x6b7f96, trunk: 0x59452f, leaf: 0x3f7a35,
      post: 0xdfe4ea, postStripe: 0xd94141,
    },
    // Longer straight, a crest over turn 1, a tighter chicane and more
    // elevation through the back half than the original layout.
    controlPoints: [
      [   0,  0.0, -215],
      [   0,  0.0, -120],
      [   2,  2.0,  -20],
      [  12,  4.5,   75],   // crest at the top of the hill
      [  38,  3.5,  150],
      [  95,  1.5,  190],
      [ 160,  0.5,  180],
      [ 200,  0.0,  128],
      [ 198,  0.0,   62],
      [ 156,  0.5,   16],   // chicane in
      [ 128,  1.5,  -32],   // chicane out
      [ 172,  2.5,  -74],
      [ 202,  2.0, -132],
      [ 168,  0.5, -192],
      [ 108, -1.5, -228],
      // The hairpin must sweep around without ever reversing against its own
      // previous leg. A point that sits back the way the path just came from
      // makes the spline double back on itself, and the ribbon folds.
      [  56, -2.0, -276],
      [  -4, -1.8, -308],
      [ -66, -1.2, -296],
      [ -88, -0.6, -262],
      [ -46, -0.3, -252],
      // A closed Catmull-Rom's tangent at point i is (P[i+1] - P[i-1]) / 2, so
      // the point before the start line steers the direction the road arrives
      // in. Put it well off to one side and the road hooks into the straight
      // instead of flowing onto it -- which is what made the old closing
      // corner an unreadable kink. Roughly in line with the straight is what
      // keeps it smooth.
      // Sits ON the start straight's line, 55 m short of the line itself. A
      // closed Catmull-Rom's tangent at the start point is (P1 - Plast)/2, so
      // putting Plast anywhere off that line tilts the tangent and the spline
      // whips into a tiny-radius loop right at the join -- which is the one
      // corner every circuit here kept failing on.
      [   0, -0.2, -270],
    ],
  },

  // ----------------------------------------------------------------- woods --
  woods: {
    id: 'woods',
    name: 'Woods',
    tagline: 'Narrow, twisty and hemmed in by trees',
    difficulty: 'Hard',
    halfWidth: 4.6,           // a genuinely narrow road
    curbWidth: 1.0,
    fog: { near: 120, far: 620 },
    palette: {
      sky: 0x9fc2b4, skyHigh: 0x3f6b62, horizon: 0xd6e3d2,
      ground: 0x3e6b33, groundDark: 0x2c4f27,
      asphalt: 0x36383a, asphaltEdge: 0x24262a,
      curbA: 0xc8b34a, curbB: 0x2f3330,
      ridge: 0x51684f, trunk: 0x4a3826, leaf: 0x2f5c2a,
      post: 0xd8dcc8, postStripe: 0xc8b34a,
    },
    hills: { amplitude: 1.5, scale: 1.6 },
    banking: { gain: 150, maxDegrees: 2.5 },  // narrow lanes, modest camber
    surface: { roadGrip: 0.96, grassGrip: 0.34 },   // damp, mossy tarmac
    sun: { color: 0xdfeccd, intensity: 1.7, position: [50, 90, -60] },
    scenery: {
      treeCount: 1400, treeHeight: [5.0, 11.0], treeRadius: [1.2, 2.0],
      treeSegments: 5, treeClearance: 9,            // trees crowd the verges
      ridgeCount: 48, ridgeHeight: [40, 90], ridgeRadius: 800, ridgeJitter: 120,
      postSpacing: 9,
    },
    // Tight and busy: a compact loop with direction changes one after another.
    controlPoints: [
      [   0,  0.0, -120],
      [   0,  1.0,  -55],
      [ -28,  2.5,  -14],
      [ -16,  3.5,   40],
      [  26,  3.0,   62],
      [  44,  1.5,   18],
      [  86,  0.5,    6],
      [ 118,  1.5,   46],
      [ 154,  2.5,   30],
      [ 150,  2.0,  -26],
      [ 112,  1.0,  -44],
      [ 122,  0.0,  -96],
      [  88, -1.0, -130],
      [  46, -1.6, -152],
      [  -6, -1.0, -178],
      [ -48, -0.4, -152],
      [ -34,  0.0, -108],
    ],
  },

  // ------------------------------------------------------------------ snow --
  snow: {
    id: 'snow',
    name: 'Snow',
    tagline: 'Wide, flowing and very short on grip',
    difficulty: 'Slippery',
    halfWidth: 7.5,           // wide, because you will need the room
    fog: { near: 180, far: 900 },
    palette: {
      sky: 0xbcd3e6, skyHigh: 0x7d9fc0, horizon: 0xeef4f8,
      ground: 0xeef2f6, groundDark: 0xcdd8e4,
      asphalt: 0x5c626b, asphaltEdge: 0x474d55,
      curbA: 0xcf4d4d, curbB: 0xf7f9fb,
      ridge: 0xb9cbdc, trunk: 0x4a4034, leaf: 0x2f4a3f,
      post: 0xd94141, postStripe: 0xf2f2f2,
      skidmark: 0x3c4550,   // ruts cut into packed snow, not black rubber
    },
    hills: { amplitude: 1.3, scale: 0.8 },
    // Steeply banked bowls: with this little grip, camber is what holds you on.
    banking: { gain: 230, maxDegrees: 4.5 },
    // The whole point of this one: packed snow gives up early, and running
    // wide into the deep stuff is close to unrecoverable.
    surface: { roadGrip: 0.55, grassGrip: 0.22 },
    sun: { color: 0xeaf1ff, intensity: 1.9, position: [-80, 100, 60] },
    scenery: {
      treeCount: 420, treeHeight: [4.5, 9.0], treeRadius: [1.4, 2.2],
      treeSegments: 6, treeClearance: 20,
      ridgeCount: 56, ridgeHeight: [90, 260], ridgeRadius: 1050, ridgeJitter: 220,
      postSpacing: 10,
    },
    // Long open curves -- deliberately few hard braking points, because
    // stopping is the hard part here.
    controlPoints: [
      [   0,  0.0, -190],
      [   0,  0.5,  -80],
      [  20,  1.5,   30],
      [  74,  2.0,  120],
      [ 150,  1.5,  158],
      [ 226,  0.5,  132],
      [ 262,  0.0,   50],
      [ 244,  0.0,  -40],
      [ 180,  0.5, -104],
      [ 186,  1.5, -170],
      [ 128,  2.0, -222],
      [  46,  1.0, -238],
      [ -30,  0.0, -252],
      [ -84,  0.0, -210],
      [ -92,  0.0, -140],
      [ -60,  0.0,  -92],
      [ -26,  0.0, -132],   // turns back south, staying well west of the
      [ -30,  0.0, -196],   // start straight so the ribbons never overlap
      [  -2,  0.0, -224],   // and arrives almost in line with it
    ],
  },

  // ------------------------------------------------------------- mountains --
  mountains: {
    id: 'mountains',
    name: 'Mountains',
    tagline: 'Big climbs, faster descents, no room for error',
    difficulty: 'Hard',
    halfWidth: 6.2,
    fog: { near: 300, far: 1500 },
    // This circuit doubles back over itself with big height differences. Too
    // shallow an envelope carves a trench beside the road that the car falls
    // into; too steep and the terrain chords above the asphalt over a crest.
    // 0.20 with deeper clearance clears both.
    envSlope: 0.20,
    roadClearance: 0.30,
    palette: {
      sky: 0x5aa0dd, skyHigh: 0x1d4f8c, horizon: 0xdfe9ef,
      ground: 0x7d7a63, groundDark: 0x5d5b49,
      asphalt: 0x44474d, asphaltEdge: 0x33363b,
      curbA: 0xe0e3e8, curbB: 0x2c2f34,
      ridge: 0x8492a6, trunk: 0x5a4a35, leaf: 0x466b3f,
      post: 0xf0f2f5, postStripe: 0x2c2f34,
    },
    hills: { amplitude: 3.4, scale: 1.2 },
    // Mountain-pass camber, tipping hard into the switchbacks.
    banking: { gain: 220, maxDegrees: 4.5 },
    surface: { roadGrip: 0.98, grassGrip: 0.30 },   // gravel run-off
    sun: { color: 0xfff0d0, intensity: 2.7, position: [110, 140, -40] },
    scenery: {
      treeCount: 340, treeHeight: [4.0, 9.5], treeRadius: [1.3, 2.1],
      treeSegments: 5, treeClearance: 22,
      ridgeCount: 84, ridgeHeight: [420, 980], ridgeRadius: 1180, ridgeJitter: 300,
      postSpacing: 8,
    },
    // The elevation IS the circuit: a ~65 m climb over the first half, then a
    // long descent that arrives at the final corners carrying far too much
    // speed. Roughly a 7% average gradient, which is real mountain-pass
    // territory. The B-spline plus the 55 m elevation filter smooth the
    // gradient changes, so the heightfield never chords above the asphalt.
    controlPoints: [
      [    0,    0.0,  -200],
      [    4,    2.0,  -110],
      [   30,    5.5,   -40],
      [   82,    9.5,    10],
      [  148,   13.5,    34],
      [  210,   16.5,     6],
      [  240,   18.0,   -62],
      [  214,   17.5,  -130],
      [  156,   15.0,  -166],
      [  100,   11.5,  -206],
      [  126,    8.0,  -272],
      [   70,    4.5,  -312],
      [   -6,    2.5,  -318],
      [  -72,    1.5,  -286],
      [  -96,    0.8,  -226],
      [  -78,    0.3,  -166],
      [  -92,    0.1,  -108],
      [  -58,    0.0,   -74],
      [  -46,    0.0,  -150],
      [  -30,    0.0,  -214],
      [   -3,    0.0,  -263],
    ],
  },
};

export const TRACK_IDS = Object.keys(TRACKS);
export const DEFAULT_TRACK = 'forest';

/** Merge a definition over the shared defaults, so entries only state what differs. */
export function getTrack(id) {
  const def = TRACKS[id] || TRACKS[DEFAULT_TRACK];
  return {
    ...BASE,
    ...def,
    fog: { ...BASE.fog, ...(def.fog || {}) },
    hills: { ...BASE.hills, ...(def.hills || {}) },
    surface: { ...BASE.surface, ...(def.surface || {}) },
    sun: { ...BASE.sun, ...(def.sun || {}) },
    scenery: { ...BASE.scenery, ...(def.scenery || {}) },
  };
}
