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
  neverFog: false,
  revealedDarkness: 0.2,
  revealedSaturation: 0.85
};

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

const {BooleanField, NumberField, ColorField} = foundry.data.fields;

const slider = initial => new NumberField({required: true, nullable: false, min: 0, max: 1, step: 0.01, initial});
const color = initial => new ColorField({required: true, nullable: false, initial});

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
  neverFog: {key: "NeverFog", type: () => new BooleanField({initial: false})},
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
      {name: `flags.${MODULE_ID}.${name}`, value}
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
  for ( const [name, {isColor}] of Object.entries(SETTINGS) ) {
    const input = fieldset.querySelector(`[name="flags.${MODULE_ID}.${name}"]`);
    if ( !input ) continue;
    if ( input.type === "checkbox" ) values[name] = input.checked;
    else if ( isColor ) values[name] = input.value || undefined;
    else values[name] = Number(input.value);
  }
  return values;
}

/* -------------------------------------------- */
/*  Reveal Mask                                 */
/* -------------------------------------------- */

/**
 * Set after a mask error so the Never Fog masks disable themselves instead of halting the canvas render loop.
 * @type {boolean}
 */
let maskFailed = false;

/**
 * Is the Never Fog mask active for the current scene?
 * @returns {boolean}
 */
function neverFogActive() {
  return !maskFailed && state.enabled && state.neverFog && !!canvas.scene;
}

/**
 * Disable the Never Fog masks after an error, with a notification.
 * @param {Error} err
 */
function failMask(err) {
  maskFailed = true;
  console.error(`${MODULE_ID} | Never Fog mask failed and has been disabled until reload`, err);
  ui.notifications?.error("Fog Shading: Never Fog failed and was disabled. See console (F12) for details.");
}

/**
 * Copy a primary mesh's texture, anchor and world placement onto a sprite parented under `container`.
 * @param {PIXI.Sprite} sprite
 * @param {PrimarySpriteMesh} mesh
 * @param {PIXI.Matrix} toLocal    Inverse of the container's world transform
 */
function matchMesh(sprite, mesh, toLocal) {
  sprite.texture = mesh.texture;
  sprite.anchor.copyFrom(mesh.anchor);
  sprite.transform.setFromMatrix(toLocal.clone().append(mesh.worldTransform));
  sprite.visible = true;
}

/**
 * Screen-space mask of the areas under faded roofs that should get normal fog: each faded roof's image, trimmed
 * to the opaque pixels of the viewed Level's background. On an upper floor this keeps the roof overhang (where
 * the floor image is transparent and you see the ground below) out of the fogged area; on a ground floor whose
 * background covers the map it is simply the roof image.
 *
 * A roof is any tile with a Fade, Radial or Vision occlusion mode, or a Level flagged as a roof level. Rendered
 * before RevealMask, which subtracts it from the revealed area.
 */
class RoofPunchMask extends foundry.canvas.containers.CachedContainer {
  constructor() {
    super();
    this.roofs = this.addChild(new PIXI.Container());
    this.floor = this.addChild(new PIXI.Sprite());
    this.floor.blendMode = PIXI.BLEND_MODES.DST_IN;
    this.floor.visible = false;
  }

  /** @override */
  static textureConfiguration = {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    format: PIXI.FORMATS.RGBA,
    multisample: PIXI.MSAA_QUALITY.NONE
  };

  /** Occlusion modes that make a tile a roof. */
  static #ROOF_MODES = CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.VISION;

  /** @override */
  clearColor = [0, 0, 0, 0];

  /**
   * How many faded roofs were drawn this frame. RevealMask skips the punch when zero.
   * @type {number}
   */
  count = 0;

  /** @override */
  clear() {
    this.count = 0;
    for ( const sprite of [...this.roofs.children, this.floor] ) {
      sprite.texture = PIXI.Texture.EMPTY;
      sprite.visible = false;
    }
    return this;
  }

  /** @override */
  render(renderer) {
    this.count = 0;
    this.renderable = neverFogActive();
    if ( !this.renderable ) return;
    try {
      const toLocal = this.worldTransform.clone().invert();
      this.count = this.#refreshRoofs(toLocal);
      if ( !this.count ) return;
      this.#refreshFloor(toLocal);
      // The stage's transform pass already ran this frame; recompute so sprites match the meshes now
      this.roofs.updateTransform();
      this.floor.updateTransform();
    } catch(err) {
      this.count = 0;
      this.renderable = false;
      failMask(err);
      return;
    }
    super.render(renderer);
  }

  /**
   * Draw each currently faded roof's image in white.
   * @param {PIXI.Matrix} toLocal
   * @returns {number}    The number of faded roofs drawn
   */
  #refreshRoofs(toLocal) {
    const sprites = this.roofs.children;
    let i = 0;
    for ( const mesh of RoofPunchMask.#roofMeshes() ) {
      if ( !mesh.visible || !RoofPunchMask.#isFadedRoof(mesh) ) continue;
      const sprite = sprites[i++] ?? this.roofs.addChild(new PIXI.Sprite());
      matchMesh(sprite, mesh, toLocal);
    }
    for ( let j = i; j < sprites.length; j++ ) sprites[j].visible = false;
    return i;
  }

  /**
   * Trim the drawn roofs to the opaque pixels of the viewed Level's background (DST_IN keeps destination pixels
   * in proportion to the floor image's alpha). Without a background image, nothing is trimmed.
   * @param {PIXI.Matrix} toLocal
   */
  #refreshFloor(toLocal) {
    const index = canvas.level?.index;
    const mesh = canvas.primary.levelTextures.find(m => m.name === `Level.${index}.background`);
    if ( mesh?.visible && (mesh.texture !== PIXI.Texture.EMPTY) ) matchMesh(this.floor, mesh, toLocal);
    else this.floor.visible = false;
  }

  /**
   * Candidate roof meshes: visible tiles, plus the background of any Level flagged as a roof level.
   * @yields {PrimarySpriteMesh}
   */
  static *#roofMeshes() {
    for ( const tile of canvas.tiles.placeables ) {
      if ( tile.mesh && tile.visible ) yield tile.mesh;
    }
    for ( const mesh of canvas.primary.levelTextures ) {
      if ( mesh[ROOF_LEVEL_KEY] ) yield mesh;
    }
  }

  /**
   * Is this mesh a roof that core currently has faded?
   * Hover-fade only counts when no vision occlusion is active; with vision active core limits hover-fade to what
   * your tokens can already see.
   * @param {PrimarySpriteMesh} mesh
   * @returns {boolean}
   */
  static #isFadedRoof(mesh) {
    if ( !(mesh.occlusionMode & RoofPunchMask.#ROOF_MODES) ) return false;
    if ( mesh.occluded ) return true;
    return !canvas.masks.occlusion.vision && (mesh._hoverFadeState?.occlusion > 0);
  }
}

/**
 * Screen-space mask (red channel) of areas that are never drawn as fog: the whole scene, minus the areas under
 * faded roofs from RoofPunchMask. Lives in the hidden canvas group alongside core's vision/occlusion masks so it
 * renders before the visibility filter samples it.
 */
class RevealMask extends foundry.canvas.containers.CachedContainer {
  constructor() {
    super();
    this.background = this.addChild(new PIXI.LegacyGraphics());
    this.punch = this.addChild(new PIXI.Sprite());
    this.punch.tint = 0x000000;
    this.punch.visible = false;
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
   * The scene rect the background was drawn for.
   * @type {PIXI.Rectangle|null}
   */
  #sceneRect = null;

  /** @override */
  clear() {
    this.background.clear();
    this.#sceneRect = null;
    this.punch.texture = PIXI.Texture.EMPTY;
    this.punch.visible = false;
    return this;
  }

  /** @override */
  render(renderer) {
    this.renderable = neverFogActive();
    if ( !this.renderable ) return;
    try {
      this.#refreshBackground();
      this.#refreshPunch();
    } catch(err) {
      this.renderable = false;
      failMask(err);
      return;
    }
    super.render(renderer);
  }

  /**
   * Fill the scene rect: everything is revealed unless a faded roof says otherwise.
   */
  #refreshBackground() {
    const rect = canvas.dimensions.sceneRect;
    const r = this.#sceneRect;
    if ( r && (r.x === rect.x) && (r.y === rect.y) && (r.width === rect.width) && (r.height === rect.height) ) return;
    this.#sceneRect = rect.clone();
    this.background.clear().beginFill(0xFFFFFF, 1).drawShape(rect).endFill();
  }

  /**
   * Draw the roof punch texture (already screen-space) in black over the background, at screen coordinates.
   */
  #refreshPunch() {
    const punch = canvas.masks.fogShadingPunch;
    this.punch.visible = !!punch?.count;
    if ( !this.punch.visible ) return;
    this.punch.texture = punch.renderTexture;
    this.punch.transform.setFromMatrix(this.worldTransform.clone().invert());
    this.punch.updateTransform();
  }
}

/* -------------------------------------------- */
/*  Roof Levels                                 */
/* -------------------------------------------- */

/** Property set on a Level background mesh that acts as a roof. */
const ROOF_LEVEL_KEY = `${MODULE_ID}.roof`;

/**
 * Roof level fade styles, stored in the Level's flags.fog-shading.roof.
 * - none: not a roof
 * - fade: the whole image fades while a token is under any of its opaque pixels (like a Fade roof tile)
 * - vision: the image becomes see-through only where your tokens can see (like a Vision roof tile)
 */
const ROOF_STYLES = {
  none: "FOGSHADING.RoofLevel.None",
  fade: "FOGSHADING.RoofLevel.Fade",
  vision: "FOGSHADING.RoofLevel.Vision"
};

/**
 * The roof style of a Level. Earlier versions stored a boolean, which meant "fade".
 * @param {Level} level
 * @returns {"none"|"fade"|"vision"}
 */
function getRoofStyle(level) {
  const value = level.flags[MODULE_ID]?.roof;
  if ( value === true ) return "fade";
  return value in ROOF_STYLES ? value : "none";
}

/**
 * Give the background of every roof Level core's Fade or Vision occlusion, exactly like a roof tile. Core draws
 * Level textures with Surface occlusion only; the roof mode is added on top so region-based surfaces keep working.
 */
function applyRoofLevels() {
  if ( !canvas.scene || !canvas.primary?.levelTextures ) return;
  const M = CONST.OCCLUSION_MODES;
  const modes = {none: 0, fade: M.FADE, vision: M.VISION};
  for ( const level of canvas.scene.levels ) {
    const mesh = canvas.primary.levelTextures.find(m => m.name === `Level.${level.index}.background`);
    if ( !mesh ) continue;
    const style = getRoofStyle(level);
    mesh.occlusionMode = M.SURFACE | modes[style];
    mesh[ROOF_LEVEL_KEY] = style !== "none";
  }
  canvas.perception.update({refreshOcclusion: true});
}

/**
 * Add a "Roof Level" select to the Background section of the Level config sheet.
 */
function injectLevelConfig(app, element) {
  if ( !game.user.isGM ) return;
  const name = `flags.${MODULE_ID}.roof`;
  if ( element.querySelector(`[name="${name}"]`) ) return;
  const bgFieldset = element.querySelector('[name="background.src"]')?.closest("fieldset");
  if ( !bgFieldset ) return;
  const loc = key => game.i18n.localize(key);
  const choices = Object.fromEntries(Object.entries(ROOF_STYLES).map(([k, v]) => [k, loc(v)]));
  const field = new foundry.data.fields.StringField({required: true, blank: false, initial: "none", choices});
  bgFieldset.append(field.toFormGroup(
    {label: loc("FOGSHADING.RoofLevel.Name"), hint: loc("FOGSHADING.RoofLevel.Hint")},
    {name, value: getRoofStyle(app.document)}
  ));
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
  // Punch renders first: RevealMask samples its texture in the same frame
  if ( !canvas.masks.fogShadingPunch ) canvas.hidden.addMask("fogShadingPunch", new RoofPunchMask());
  if ( !canvas.masks.fogShadingReveal ) canvas.hidden.addMask("fogShadingReveal", new RevealMask());
});
Hooks.on("updateScene", (scene, changes) => {
  if ( (scene.id === canvas.scene?.id) && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) refreshState();
});
Hooks.on("renderSceneConfig", injectSceneConfig);
Hooks.on("renderLevelConfig", injectLevelConfig);
Hooks.on("drawPrimaryCanvasGroup", applyRoofLevels);
Hooks.on("updateLevel", (level, changes) => {
  if ( (level.parent === canvas.scene) && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) applyRoofLevels();
});
Hooks.on("closeSceneConfig", () => {
  if ( preview === null ) return;
  preview = null;
  refreshState();
});
