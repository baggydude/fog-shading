/**
 * Workaround for a core bug (v14): ClientKeybindings#onMove returns early when the canvas is not ready, before it
 * handles key-up. A movement key released during a canvas redraw (teleport, scene or level change) is therefore never
 * removed from game.keyboard.moveKeys, and every later keyboard move is combined with the stuck direction.
 * Clearing the sets once the canvas is ready is safe: keys still physically held are re-added by key-repeat.
 */
Hooks.on("canvasReady", () => {
  game.keyboard.moveKeys.clear();
  game.keyboard.panKeys.clear();
});
