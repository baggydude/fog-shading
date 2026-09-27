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
  useFogImage: false
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
  useFogImage: {key: "UseFogImage", type: () => new BooleanField({initial: false})}
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
      fsExploredTint: [0, 0, 0]
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

      ${persistent ? `
      gl_FragColor = mix(unexplored, vec4(0.0), r);` : `
      // Explored but not currently visible
      vec4 explored;
      if ( fsEnabled ) explored = vec4(grade(baseColor.rgb, fsExplored, fsExploredTint), 1.0);
      else {
        float reflec = perceivedBrightness(baseColor.rgb);
        explored = vec4(min((exploredColor * reflec) + (baseColor.rgb * exploredColor), vec3(1.0)), 0.5);
      }

      vec4 fow = mix(unexplored, explored, max(r, v));
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
