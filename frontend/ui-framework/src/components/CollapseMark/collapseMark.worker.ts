/* The collapse's drawing, off the main thread.
 *
 * Drawing the collapse is cheap; what is not is the browser handing a freshly
 * drawn canvas to the compositor every frame, which it does on whichever
 * thread owns the canvas. Owned here, both that and the geometry leave the
 * main thread, which is left posting one number a frame.
 *
 * Deliberately exports nothing: the package's barrel re-exports every module
 * that exports, and this one must only ever run as a worker. */
import { createCollapseMarkPlayer, type CollapseMarkMessage, type CollapseMarkPlayer } from './collapseMarkScene'

let player: CollapseMarkPlayer | null = null

self.onmessage = (event: MessageEvent<CollapseMarkMessage>) => {
  const message = event.data
  if (message.type === 'init') {
    message.canvas.width = message.width
    message.canvas.height = message.height
    player = createCollapseMarkPlayer(message.canvas, message.inks, { box: message.box, onGather: (event) => self.postMessage(event) })
    player.draw(0)
  } else if (message.type === 'resize') {
    player?.resize(message.width, message.height, message.box)
  } else {
    player?.draw(message.phase, message.frame)
  }
}
