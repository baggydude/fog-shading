const MODULE_ID = "fog-shading";

/**
 * Cached, shader-ready copies of the module settings. Refreshed whenever a setting changes so the
 * per-frame filter apply() never has to touch game.settings.
 */
const state = {
  enabled: true,
  neverFog: false,
  revealedDarkness: 0.2,
  revealedSaturation: 0.85,
  unexploredDarkness: 0.85,
  unexploredSaturation: 0.0,
  exploredDarkness: 0.55,
  exploredSaturation: 0.35,
  sceneDarknessInfluence: 0.5
};

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

const {BooleanField, NumberField} = foundry.data.fields;

const slider = initial => new NumberField({required: true, nullable: false, min: 0, max: 1, step: 0.01, initial});

/**
 * Settings in display order. `dependsOn` names a checkbox setting; the input is only shown while it is ticked.
 */
const SETTINGS = {
  enabled: {key: "Enabled", type: () => new BooleanField({initial: true})},
  neverFog: {key: "NeverFog", type: () => new BooleanField({initial: false})},
  revealedDarkness: {key: "RevealedDarkness", type: () => slider(0.2), dependsOn: "neverFog"},
  revealedSaturation: {key: "RevealedSaturation", type: () => slider(0.85), dependsOn: "neverFog"},
  unexploredDarkness: {key: "UnexploredDarkness", type: () => slider(0.85)},
  unexploredSaturation: {key: "UnexploredSaturation", type: () => slider(0.0)},
  exploredDarkness: {key: "ExploredDarkness", type: () => slider(0.55)},
  exploredSaturation: {key: "ExploredSaturation", type: () => slider(0.35)},
  sceneDarknessInfluence: {key: "SceneDarknessInfluence", type: () => slider(0.5)}
};

/**
 * Show or hide dependent inputs (e.g. the Never Fog sliders) according to their controlling checkbox.
 * @param {HTMLElement} root              Element containing the inputs
 * @param {(name: string) => string} inputName  Maps a setting name to its input's name attribute
 */
function bindDependencies(root, inputName) {
  for ( const [name, {dependsOn}] of Object.entries(SETTINGS) ) {
    if ( !dependsOn ) continue;
    const group = root.querySelector(`[name="${inputName(name)}"]`)?.closest(".form-group");
    const control = root.querySelector(`[name="${inputName(dependsOn)}"]`);
    if ( !group || !control ) continue;
    const sync = () => group.hidden = !control.checked;
    control.addEventListener("change", sync);
    sync();
  }
}

/**
 * Apply dependent-input visibility in the module settings window.
 */
function onRenderSettingsConfig(app, element) {
  bindDependencies(element, name => `${MODULE_ID}.${name}`);
}

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
  for ( const name of Object.keys(SETTINGS) ) state[name] = source?.[name] ?? game.settings.get(MODULE_ID, name);
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
  for ( const [name, {key, type}] of Object.entries(SETTINGS) ) {
    body.append(type().toFormGroup(
      {label: loc(`FOGSHADING.${key}.Name`), hint: loc(`FOGSHADING.${key}.Hint`)},
      {name: `flags.${MODULE_ID}.${name}`, value: flags[name] ?? game.settings.get(MODULE_ID, name)}
    ));
  }
  fieldset.append(body);
  bindDependencies(body, name => `flags.${MODULE_ID}.${name}`);

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
  for ( const name of Object.keys(SETTINGS) ) {
    const input = fieldset.querySelector(`[name="flags.${MODULE_ID}.${name}"]`);
    if ( !input ) continue;
    if ( input.type === "checkbox" ) values[name] = input.checked;
    else values[name] = Number(input.value);
  }
  return values;
}

/* -------------------------------------------- */
/*  Reveal Mask                                 */
/* -------------------------------------------- */

/**
 * Screen-space mask (red channel) of areas that are never drawn as fog. Lives in the hidden canvas group
 * alongside core's vision/occlusion masks so it renders before the visibility filter samples it.
 *
 * The whole scene is revealed, minus every roof tile that core currently has faded. A roof is any tile with a
 * Fade, Radial or Vision occlusion mode; its cut-out is the tile's own image (alpha), drawn with the tile's
 * transform. Because this keys off the same flag that fades the roof, fog returns beneath a roof at exactly the
 * moment the roof disappears.
 */
class RevealMask extends foundry.canvas.containers.CachedContainer {
  constructor() {
    super();
    this.background = this.addChild(new PIXI.LegacyGraphics());
    this.roofs = this.addChild(new PIXI.Container());
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
   * The scene rect the background was drawn for.
   * @type {PIXI.Rectangle|null}
   */
  #sceneRect = null;

  /** @override */
  clear() {
    this.background.clear();
    this.#sceneRect = null;
    for ( const sprite of this.roofs.children ) {
      sprite.texture = PIXI.Texture.EMPTY;
      sprite.visible = false;
    }
    return this;
  }

  /**
   * Set after an error so a broken mask disables itself instead of halting the canvas render loop.
   * @type {boolean}
   */
  #failed = false;

  /** @override */
  render(renderer) {
    this.renderable = !this.#failed && state.enabled && state.neverFog && !!canvas.scene;
    if ( !this.renderable ) return;
    try {
      // With all your tokens inside, the outside follows normal fog too
      if ( !RevealMask.#anyViewerOutside() ) {
        this.renderable = false;
        return;
      }
      this.#refreshBackground();
      this.#refreshRoofs();
    } catch(err) {
      this.#failed = true;
      this.renderable = false;
      console.error(`${MODULE_ID} | Never Fog mask failed and has been disabled until reload`, err);
      ui.notifications?.error("Fog Shading: Never Fog failed and was disabled. See console (F12) for details.");
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
   * Draw each currently faded roof tile's image in black, restoring normal fog beneath it.
   */
  #refreshRoofs() {
    const sprites = this.roofs.children;
    const toLocal = this.worldTransform.clone().invert();
    let i = 0;
    for ( const mesh of RevealMask.#roofMeshes() ) {
      if ( !mesh.visible || !RevealMask.#isFadedRoof(mesh) ) continue;
      const sprite = sprites[i++] ?? this.roofs.addChild(new PIXI.Sprite());
      sprite.texture = mesh.texture;
      sprite.anchor.copyFrom(mesh.anchor);
      sprite.tint = 0x000000;
      sprite.transform.setFromMatrix(toLocal.clone().append(mesh.worldTransform));
      sprite.visible = true;
    }
    for ( ; i < sprites.length; i++ ) sprites[i].visible = false;

    // The stage's transform pass already ran this frame; recompute so sprites match the roofs now, not next frame
    this.roofs.updateTransform();
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
   * Is at least one token you're seeing through outside, i.e. not under any roof? Uses core's own roof test
   * (testOcclusion: below the roof and under its opaque pixels). With no vision tokens, counts as outside.
   * @returns {boolean}
   */
  static #anyViewerOutside() {
    const viewers = [];
    for ( const source of canvas.effects.visionSources ) {
      const token = source.object;
      if ( source.active && (token instanceof foundry.canvas.placeables.Token) ) viewers.push(token);
    }
    if ( !viewers.length ) return true;
    const roofs = [];
    for ( const mesh of RevealMask.#roofMeshes() ) {
      if ( mesh.visible && (mesh.occlusionMode & RevealMask.#ROOF_MODES) ) roofs.push(mesh);
    }
    return viewers.some(token => !roofs.some(mesh => mesh.testOcclusion(token)));
  }

  /**
   * Is this mesh a roof that core currently has faded?
   * Hover-fade only counts when no vision occlusion is active; with vision active core limits hover-fade to what
   * your tokens can already see.
   * @param {PrimarySpriteMesh} mesh
   * @returns {boolean}
   */
  static #isFadedRoof(mesh) {
    if ( !(mesh.occlusionMode & RevealMask.#ROOF_MODES) ) return false;
    if ( mesh.occluded || !mesh.renderable ) return true;   // Not renderable: hidden by the GM Hide Roofs toggle
    return !canvas.masks.occlusion.vision && (mesh._hoverFadeState?.occlusion > 0);
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
    // Core creates Level textures with hover-fade off; let the GM hover a roof level to see and edit beneath it
    mesh.hoverFade = (style !== "none") && game.user.isGM;
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
/*  GM Hide Roofs                               */
/* -------------------------------------------- */

/**
 * Occlusion modes that make a mesh a roof (tiles and roof Levels).
 */
const ROOF_OCCLUSION_MODES = CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.VISION;

/**
 * Whether the GM has toggled all roofs hidden. Per-client and not saved; resets on reload.
 * @type {boolean}
 */
let roofsHidden = false;

/**
 * Meshes this module has made non-renderable, so they can be restored.
 * @type {Set<PrimarySpriteMesh>}
 */
const hiddenRoofMeshes = new Set();

/**
 * Every roof mesh on the canvas: tiles with a roof occlusion mode and roof Level backgrounds.
 * @yields {PrimarySpriteMesh}
 */
function* allRoofMeshes() {
  for ( const tile of canvas.tiles?.placeables ?? [] ) {
    if ( tile.mesh && (tile.mesh.occlusionMode & ROOF_OCCLUSION_MODES) ) yield tile.mesh;
  }
  for ( const mesh of canvas.primary?.levelTextures ?? [] ) {
    if ( mesh[ROOF_LEVEL_KEY] ) yield mesh;
  }
}

/**
 * Keep roofs hidden while toggled. Runs every frame because tiles and Level textures are recreated on redraw.
 */
function enforceHiddenRoofs() {
  if ( !roofsHidden || !canvas.ready ) return;
  for ( const mesh of allRoofMeshes() ) {
    if ( !mesh.renderable ) continue;
    mesh.renderable = false;
    hiddenRoofMeshes.add(mesh);
  }
}

/**
 * Toggle all roofs hidden for this GM client.
 * @param {boolean} [hidden]  Explicit state; toggles if omitted
 */
function setRoofsHidden(hidden = !roofsHidden) {
  if ( !game.user.isGM || (hidden === roofsHidden) ) return;
  roofsHidden = hidden;
  if ( !hidden ) {
    for ( const mesh of hiddenRoofMeshes ) if ( !mesh.destroyed ) mesh.renderable = true;
    hiddenRoofMeshes.clear();
  }
  else enforceHiddenRoofs();
  ui.notifications.info(game.i18n.localize(hidden ? "FOGSHADING.HideRoofs.On" : "FOGSHADING.HideRoofs.Off"));
  ui.controls?.render({reset: true});   // Reset re-runs getSceneControlButtons so the button reflects the state
}

/**
 * Add a Hide Roofs toggle to the Token and Tile scene controls for the GM.
 * @param {Record<string, SceneControl>} controls
 */
function addHideRoofsControl(controls) {
  if ( !game.user.isGM ) return;
  for ( const name of ["tokens", "tiles"] ) {
    const control = controls[name];
    if ( !control?.tools ) continue;
    control.tools.fogShadingHideRoofs = {
      name: "fogShadingHideRoofs",
      order: 100,
      title: "FOGSHADING.HideRoofs.Name",
      icon: "fa-solid fa-house-chimney-crack",
      toggle: true,
      active: roofsHidden,
      onChange: (event, toggled) => setRoofsHidden(toggled)
    };
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
 * (the live map, including any visible lower Levels) with independent darkness / saturation for both
 * states. The fog exploration mask and vision tests are untouched, and hidden tokens are never drawn into
 * the primary render, so nothing is revealed that core would hide.
 */
class ShadedVisibilityFilter extends foundry.canvas.rendering.filters.VisibilityFilter {

  /** @override */
  static get defaultUniforms() {
    return {
      ...super.defaultUniforms,
      fsEnabled: true,
      fsEnvFactor: 1,
      fsUnexplored: [0.85, 0],            // darkness, saturation
      fsExplored: [0.55, 0.35],
      fsReveal: false,
      fsRevealed: [0.2, 0.85],
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
    uniform float fsEnvFactor;
    uniform vec2 fsUnexplored;
    uniform vec2 fsExplored;
    uniform bool fsReveal;
    uniform vec2 fsRevealed;
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

    // params: x = darkness, y = saturation
    vec3 grade(in vec3 color, in vec2 params) {
      vec3 c = mix(vec3(dot(BT709, color)), color, params.y);
      return clamp(c * (1.0 - params.x) * fsEnvFactor, 0.0, 1.0);
    }

    void main() {
      float r = texture2D(uSampler, vTextureCoord).r;
      ${persistent ? "" : "float v = texture2D(visionTexture, vMaskTextureCoord).r;"}
      vec4 baseColor = texture2D(primaryTexture, vMaskTextureCoord);

      // Unexplored (core's flat colour / fog image only when Fog Shading is disabled)
      vec4 unexplored;
      if ( fsEnabled ) unexplored = vec4(grade(baseColor.rgb, fsUnexplored), 1.0);
      else if ( hasOverlayTexture ) {
        vec4 fogColor = unPremultiply(texture2D(overlayTexture, vOverlayTilingCoord) * getClip(vOverlayCoord));
        unexplored = mix(vec4(unexploredColor, 1.0), vec4(fogColor.rgb * backgroundColor, 1.0), fogColor.a);
      }
      else unexplored = vec4(unexploredColor, 1.0);

      // Never-fogged areas (outdoors) are drawn with the "revealed" grade instead of fog
      float m = fsReveal ? texture2D(fsRevealTexture, vMaskTextureCoord).r : 0.0;
      vec4 revealed = vec4(grade(baseColor.rgb, fsRevealed), 1.0);

      ${persistent ? `
      gl_FragColor = mix(mix(unexplored, revealed, m), vec4(0.0), r);` : `
      // Explored but not currently visible
      vec4 explored;
      if ( fsEnabled ) explored = vec4(grade(baseColor.rgb, fsExplored), 1.0);
      else {
        float reflec = perceivedBrightness(baseColor.rgb);
        explored = vec4(min((exploredColor * reflec) + (baseColor.rgb * exploredColor), vec3(1.0)), 0.5);
      }

      vec4 fow = mix(mix(unexplored, explored, max(r, v)), revealed, m);
      gl_FragColor = mix(fow, vec4(0.0), v);`}

      // Our fog colours are opaque, so mixing towards transparent already yields premultiplied colour.
      // Premultiplying again (as core does) darkens partially visible pixels into a seam along vision edges.
      if ( !fsEnabled ) gl_FragColor.rgb *= gl_FragColor.a;
    }`;
  }

  /** @override */
  apply(filterManager, input, output, clear) {
    const u = this.uniforms;
    const s = state;
    u.fsEnabled = s.enabled;
    u.fsEnvFactor = 1 - ((canvas.environment?.darknessLevel ?? 0) * s.sceneDarknessInfluence);
    u.fsUnexplored[0] = s.unexploredDarkness;
    u.fsUnexplored[1] = s.unexploredSaturation;
    u.fsExplored[0] = s.exploredDarkness;
    u.fsExplored[1] = s.exploredSaturation;
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
  game.keybindings.register(MODULE_ID, "hideRoofs", {
    name: "FOGSHADING.HideRoofs.Name",
    hint: "FOGSHADING.HideRoofs.Hint",
    editable: [{key: "KeyR", modifiers: ["Alt"]}],
    restricted: true,
    onDown: () => {
      setRoofsHidden();
      return true;
    }
  });
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
Hooks.on("renderSettingsConfig", onRenderSettingsConfig);
Hooks.on("getSceneControlButtons", addHideRoofsControl);
Hooks.on("canvasReady", () => {
  hiddenRoofMeshes.clear();
  // The app (and its ticker) persists across scene changes; don't stack listeners
  canvas.app.ticker.remove(enforceHiddenRoofs);
  canvas.app.ticker.add(enforceHiddenRoofs);
});
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
