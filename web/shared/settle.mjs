// When is a run of changes over? A face asks this so that a note which
// depends on the values can wait for the hand to stop, instead of coming and
// going with every pixel of a drag. No DOM and no ComfyUI imports in here,
// so it runs under node:test (tests/settle.test.mjs).
//
//   const rest = createSettle({ delay: 200, held: () => pointerIsDown, onSettle: showTheNote });
//   rest.touch()     a value changed. True: nothing else is going on, show it
//                    now. False: wait, onSettle says when.
//   rest.release()   the pointer came up; call it whenever held() turns false.
//   rest.cancel()    stop waiting (the picture or the face is gone).
//
// The rules:
// - A change with the pointer up and nothing waiting shows at once: a click,
//   a typed number, a new picture.
// - While a pointer is held nothing settles, however long the hand rests.
// - Then onSettle runs once, `delay` ms after the last change or after the
//   release, whichever came later. A burst of changes with no pointer (a
//   held arrow key) shows its first value at once and its last one after.
export function createSettle({ delay = 200, held = () => false, onSettle = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  // The wait ran out while a pointer was still held: release() starts it again.
  let waiting = false;
  // A change was held back, so onSettle has something to show.
  let owed = false;
  const arm = () => {
    if (timer !== null) clearTimer(timer);
    waiting = false;
    timer = setTimer(() => {
      timer = null;
      if (held()) { waiting = true; return; }
      if (!owed) return;
      owed = false;
      onSettle?.();
    }, delay);
  };
  return {
    touch() {
      const now = !held() && timer === null && !waiting;
      if (!now) owed = true;
      arm();
      return now;
    },
    release() {
      if (timer !== null || waiting) arm();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      waiting = false;
      owed = false;
    },
  };
}
