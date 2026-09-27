const MODULE_ID = "fog-shading";

/**
 * Cached, shader-ready copies of the module settings. Refreshed whenever a setting changes so the
 * per-frame filter apply() never has to touch game.settings.
 */
const state = {
  enabled: true,
  unexploredDarkness: 0.85,
  unexploredSaturation: 0.0,
  unexploredTint: [0, 0, 0],
  unexploredTintStrength: 0.0,
  exploredDarkness: 0.55,
  exploredSaturation: 0.35,
  exploredTint: [0, 0, 0],
  exploredTintStrength: 0.0,
  sceneDarknessInfluence: 0.5,
  useFogImage: false,
  revealMode: "off",
  revealedDarkness: 0.2,
  revealedSaturation: 0.85
};

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

const {BooleanField, NumberField, ColorField, StringField} = foundry.data.fields;

const slider = initial => new NumberField({required: true, nullable: false, min: 0, max: 1, step: 0.01, initial});
const color = initial => new ColorField({required: true, nullable: false, initial});

/**
 * Which areas are never drawn as fog.
 * - off: normal fog everywhere
 * - roofs: building footprints whose roof is currently showing
 * - outdoors: everything except the footprints of buildings whose roof is currently hidden (i.e. you're inside)
 */
const REVEAL_MODES = {
  off: "FOGSHADING.RevealMode.Off",
  roofs: "FOGSHADING.RevealMode.Roofs",
  outdoors: "FOGSHADING.RevealMode.Outdoors"
};

const SETTINGS = {
  enabled: {key: "Enabled", type: () => new BooleanField({initial: true})},
  unexploredDarkness: {key: "UnexploredDarkness", type: () => slider(0.85)},
  unexploredSaturation: {key: "UnexploredSaturation", type: () => slider(0.0)},
  unexploredTint: {key: "UnexploredTint", type: () => color("#1a2233"), isColor: true},
  unexploredTintStrength: {key: "UnexploredTintStrength", type: () => slider(0.0)},
  exploredDarkness: {key: "ExploredDarkness", type: () => slider(0.55)},
  exploredSaturation: {key: "ExploredSaturation", type: () => slider(0.35)},
  exploredTint: {key: "ExploredTint", type: () => color("#1a2233"), isColor: true},
  exploredTintStrength: {key: "ExploredTintStrength", type: () => slider(0.0)},
  sceneDarknessInfluence: {key: "SceneDarknessInfluence", type: () => slider(0.5)},
  useFogImage: {key: "UseFogImage", type: () => new BooleanField({initial: false})},
  revealMode: {key: "RevealMode", isString: true,
    type: () => new StringField({required: true, blank: false, initial: "off", choices: REVEAL_MODES})},
  revealedDarkness: {key: "RevealedDarkness", type: () => slider(0.2)},
  revealedSaturation: {key: "RevealedSaturation", type: () => slider(0.85)}
};

function registerSettings() {
  for ( const [name, {key, type}] of Object.entries(SETTINGS) ) {
    game.settings.register(MODULE_ID, name, {
      name: `FOGSHADING.${key}.Name`,
      hint: `FOGSHADING.${key}.Hint`,
      scope: "world",
      config: true,
      type: type(),
      onChange: refreshState
    });
  }
}

/**
 * Unsaved values from an open Scene Config for the viewed scene, used for live preview.
 * null = no preview; an empty object = preview "no override" (world settings).
 * @type {object|null}
 */
let preview = null;

/**
 * Resolve the effective values for the viewed scene (preview > scene override > world setting) into the
 * shader-ready state object.
 */
function refreshState() {
  const flags = canvas?.scene?.flags?.[MODULE_ID];
  const source = preview ?? (flags?.override ? flags : null);
  for ( const name of Object.keys(SETTINGS) ) {
    const value = source?.[name] ?? game.settings.get(MODULE_ID, name);
    state[name] = SETTINGS[name].isColor ? foundry.utils.Color.from(value).rgb : value;
  }
}

/* -------------------------------------------- */
/*  Scene Config                                */
/* -------------------------------------------- */

/**
 * Inject per-scene override controls into the Visibility tab of the Scene Config sheet. Inputs are named
 * flags.fog-shading.* so the sheet's normal submit saves them onto the Scene.
 */
function injectSceneConfig(app, element) {
  if ( !game.user.isGM ) return;
  const tab = element.querySelector('.tab[data-tab="visibility"]');
  if ( !tab || tab.querySelector("fieldset.fog-shading") ) return;
  const flags = app.document.flags[MODULE_ID] ?? {};
  const loc = key => game.i18n.localize(key);

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("fog-shading");
  const legend = document.createElement("legend");
  legend.textContent = loc("FOGSHADING.Scene.Legend");
  fieldset.append(legend);

  const override = new BooleanField().toFormGroup(
    {label: loc("FOGSHADING.Scene.Override.Name"), hint: loc("FOGSHADING.Scene.Override.Hint")},
    {name: `flags.${MODULE_ID}.override`, value: !!flags.override}
  );
  fieldset.append(override);

  // Value inputs stay in the DOM (and submitted) while hidden so values survive toggling the override
  const body = document.createElement("div");
  body.classList.add("fog-shading-values");
  for ( const [name, {key, type, isColor}] of Object.entries(SETTINGS) ) {
    let value = flags[name] ?? game.settings.get(MODULE_ID, name);
    if ( isColor ) value = foundry.utils.Color.from(value).css;
    body.append(type().toFormGroup(
      {label: loc(`FOGSHADING.${key}.Name`), hint: loc(`FOGSHADING.${key}.Hint`)},
      {name: `flags.${MODULE_ID}.${name}`, value, localize: true}
    ));
  }
  fieldset.append(body);

  const overrideInput = override.querySelector("input");
  const sync = () => {
    body.hidden = !overrideInput.checked;
    if ( app.document.id !== canvas.scene?.id ) return;
    preview = overrideInput.checked ? readValues(fieldset) : {};
    refreshState();
  };
  fieldset.addEventListener("input", sync);
  fieldset.addEventListener("change", sync);
  body.hidden = !overrideInput.checked;

  // Place directly after the core Fog of War fieldset
  const fogFieldset = tab.querySelector("fieldset");
  if ( fogFieldset ) fogFieldset.after(fieldset);
  else tab.append(fieldset);
}

/**
 * Read the current (unsaved) override values out of the injected fieldset.
 * @param {HTMLElement} fieldset
 * @returns {object}
 */
function readValues(fieldset) {
  const values = {};
  for ( const [name, {isColor, isString}] of Object.entries(SETTINGS) ) {
    const input = fieldset.querySelector(`[name="flags.${MODULE_ID}.${name}"]`);
    if ( !input ) continue;
    if ( input.type === "checkbox" ) values[name] = input.checked;
    else if ( isColor || isString ) values[name] = input.value || undefined;
    else values[name] = Number(input.value);
  }
  return values;
}

/* -------------------------------------------- */
/*  Reveal Mask                                 */
/* -------------------------------------------- */

/**
 * Screen-space mask (red channel) of areas that are never drawn as fog, built from Define Surface regions and
 * core's per-client occlusion state. Lives in the hidden canvas group alongside core's vision/occlusion masks so
 * it shares their world-to-screen transform and renders before the visibility filter samples it.
 *
 * Building footprints are regions with an occluding or exposed surface above the viewed Level's floor. A
 * footprint is removed from the mask while it is occluded (roof faded, e.g. your token is inside), so hiding a
 * roof can only ever return an area to normal fog, never reveal more.
 */
class RevealMask extends foundry.canvas.containers.CachedContainer {
  constructor() {
    super();
    this.shapes = this.addChild(new PIXI.LegacyGraphics());
  }

  /** @override */
  static textureConfiguration = {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    format: PIXI.FORMATS.RGBA,
    multisample: PIXI.MSAA_QUALITY.NONE
  };

  /** @override */
  clearColor = [0, 0, 0, 0];

  /**
   * Signature of the inputs the current shapes were drawn from.
   * @type {string|null}
   */
  #key = null;

  /** @type {readonly object[]|null} */
  #surfaces = null;

  /** @override */
  clear() {
    this.shapes.clear();
    this.#key = null;
    this.#surfaces = null;
    return this;
  }

  /** @override */
  render(renderer) {
    this.renderable = (state.enabled && (state.revealMode !== "off") && !!canvas.level);
    if ( !this.renderable ) return;
    this.#refreshShapes();
    super.render(renderer);
  }

  /**
   * Rebuild the mask geometry if the mode, level, surfaces or occluded surfaces changed.
   */
  #refreshShapes() {
    const level = canvas.level;
    const surfaces = canvas.scene.getSurfaces({level: level.id});
    const occluded = canvas.masks.occlusion.occludedSurfaces;
    const key = `${state.revealMode}|${level.id}|${[...occluded].map(s => s.key).join(";")}`;
    if ( (key === this.#key) && (surfaces === this.#surfaces) ) return;
    this.#key = key;
    this.#surfaces = surfaces;

    const g = this.shapes.clear();
    const floor = level.elevation.base;
    const footprints = surfaces.filter(s => (s.occlusion || s.exposure) && (s.elevation > floor));

    // Revealed area: the whole scene (outdoors) or just the building footprints (roofs)
    g.beginFill(0xFFFFFF, 1);
    if ( state.revealMode === "outdoors" ) g.drawShape(canvas.dimensions.sceneRect);
    else for ( const s of footprints ) s.region.polygonTree.drawShape(g);
    g.endFill();

    // Punch out buildings whose roof is currently hidden, restoring normal fog inside them
    g.beginFill(0x000000, 1);
    for ( const s of occluded ) s.region.polygonTree.drawShape(g);
    g.endFill();
  }
}

/* -------------------------------------------- */
/*  Visibility Filter                           */
/* -------------------------------------------- */

/**
 * Drop-in replacement for the core VisibilityFilter.
 *
 * Core renders unexplored fog as a flat colour (or a fog overlay image) and explored fog as a tinted,
 * half-transparent version of the primary canvas render. This subclass instead grades the primary render
 * (the live map, including any visible lower Levels) with independent darkness / saturation / tint for both
 * states. The fog exploration mask and vision tests are untouched, and hidden tokens are never drawn into
 * the primary render, so nothing is revealed that core would hide.
 */
class ShadedVisibilityFilter extends foundry.canvas.rendering.filters.VisibilityFilter {

  /** @override */
  static get defaultUniforms() {
    return {
      ...super.defaultUniforms,
      fsEnabled: true,
      fsUseFogImage: false,
      fsEnvFactor: 1,
      fsUnexplored: [0.85, 0, 0],         // darkness, saturation, tint strength
      fsUnexploredTint: [0, 0, 0],
      fsExplored: [0.55, 0.35, 0],
      fsExploredTint: [0, 0, 0],
      fsReveal: false,
      fsRevealed: [0.2, 0.85, 0],
      fsRevealTexture: PIXI.Texture.WHITE
    };
  }

  /** @override */
  static _createFragmentShader(options) {
    const persistent = options.persistentVision;
    return `
    varying vec2 vTextureCoord;
    varying vec2 vMaskTextureCoord;
    varying vec2 vOverlayCoord;
    varying vec2 vOverlayTilingCoord;
    uniform sampler2D uSampler;
    uniform sampler2D primaryTexture;
    uniform sampler2D overlayTexture;
    uniform vec3 unexploredColor;
    uniform vec3 backgroundColor;
    uniform bool hasOverlayTexture;
    ${persistent ? "" : `uniform sampler2D visionTexture;
    uniform vec3 exploredColor;`}

    uniform bool fsEnabled;
    uniform bool fsUseFogImage;
    uniform float fsEnvFactor;
    uniform vec3 fsUnexplored;
    uniform vec3 fsUnexploredTint;
    uniform vec3 fsExplored;
    uniform vec3 fsExploredTint;
    uniform bool fsReveal;
    uniform vec3 fsRevealed;
    uniform sampler2D fsRevealTexture;

    ${this.CONSTANTS}
    ${this.PERCEIVED_BRIGHTNESS}

    float getClip(in vec2 uv) {
      return step(3.5, step(0.0, uv.x) + step(0.0, uv.y) + step(uv.x, 1.0) + step(uv.y, 1.0));
    }

    vec4 unPremultiply(in vec4 pix) {
      if ( !hasOverlayTexture || (pix.a == 0.0) ) return pix;
      return vec4(pix.rgb / pix.a, pix.a);
    }

    // params: x = darkness, y = saturation, z = tint strength
    vec3 grade(in vec3 color, in vec3 params, in vec3 tint) {
      float lum = dot(BT709, color);
      vec3 c = mix(vec3(lum), color, params.y);
      c = mix(c, tint * lum * 2.0, params.z);
      return clamp(c * (1.0 - params.x) * fsEnvFactor, 0.0, 1.0);
    }

    void main() {
      float r = texture2D(uSampler, vTextureCoord).r;
      ${persistent ? "" : "float v = texture2D(visionTexture, vMaskTextureCoord).r;"}
      vec4 baseColor = texture2D(primaryTexture, vMaskTextureCoord);

      // Unexplored
      vec4 unexplored;
      if ( hasOverlayTexture && (fsUseFogImage || !fsEnabled) ) {
        vec4 fogColor = unPremultiply(texture2D(overlayTexture, vOverlayTilingCoord) * getClip(vOverlayCoord));
        unexplored = mix(vec4(unexploredColor, 1.0), vec4(fogColor.rgb * backgroundColor, 1.0), fogColor.a);
      }
      else if ( fsEnabled ) unexplored = vec4(grade(baseColor.rgb, fsUnexplored, fsUnexploredTint), 1.0);
      else unexplored = vec4(unexploredColor, 1.0);

      // Never-fogged areas (roofs / outdoors) are drawn with the "revealed" grade instead of fog
      float m = fsReveal ? texture2D(fsRevealTexture, vMaskTextureCoord).r : 0.0;
      vec4 revealed = vec4(grade(baseColor.rgb, fsRevealed, vec3(0.0)), 1.0);

      ${persistent ? `
      gl_FragColor = mix(mix(unexplored, revealed, m), vec4(0.0), r);` : `
      // Explored but not currently visible
      vec4 explored;
      if ( fsEnabled ) explored = vec4(grade(baseColor.rgb, fsExplored, fsExploredTint), 1.0);
      else {
        float reflec = perceivedBrightness(baseColor.rgb);
        explored = vec4(min((exploredColor * reflec) + (baseColor.rgb * exploredColor), vec3(1.0)), 0.5);
      }

      vec4 fow = mix(mix(unexplored, explored, max(r, v)), revealed, m);
      gl_FragColor = mix(fow, vec4(0.0), v);`}

      gl_FragColor.rgb *= gl_FragColor.a;
    }`;
  }

  /** @override */
  apply(filterManager, input, output, clear) {
    const u = this.uniforms;
    const s = state;
    u.fsEnabled = s.enabled;
    u.fsUseFogImage = s.useFogImage;
    u.fsEnvFactor = 1 - ((canvas.environment?.darknessLevel ?? 0) * s.sceneDarknessInfluence);
    u.fsUnexplored[0] = s.unexploredDarkness;
    u.fsUnexplored[1] = s.unexploredSaturation;
    u.fsUnexplored[2] = s.unexploredTintStrength;
    u.fsExplored[0] = s.exploredDarkness;
    u.fsExplored[1] = s.exploredSaturation;
    u.fsExplored[2] = s.exploredTintStrength;
    u.fsUnexploredTint = s.unexploredTint;
    u.fsExploredTint = s.exploredTint;
    const mask = canvas.masks.fogShadingReveal;
    u.fsReveal = !!mask?.renderable;
    u.fsRevealTexture = mask?.renderTexture ?? PIXI.Texture.WHITE;
    u.fsRevealed[0] = s.revealedDarkness;
    u.fsRevealed[1] = s.revealedSaturation;
    super.apply(filterManager, input, output, clear);
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();
  CONFIG.Canvas.visibilityFilter = ShadedVisibilityFilter;
});

Hooks.once("setup", refreshState);
Hooks.on("canvasInit", () => {
  preview = null;
  refreshState();
  if ( !canvas.masks.fogShadingReveal ) canvas.hidden.addMask("fogShadingReveal", new RevealMask());
});
Hooks.on("updateScene", (scene, changes) => {
  if ( (scene.id === canvas.scene?.id) && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) refreshState();
});
Hooks.on("renderSceneConfig", injectSceneConfig);
Hooks.on("closeSceneConfig", () => {
  if ( preview === null ) return;
  preview = null;
  refreshState();
});
