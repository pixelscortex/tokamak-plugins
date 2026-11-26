import { createSignal, onCleanup } from "solid-js";

/** How close to the end still counts as reading the latest. */
const NEAR_END = 32;

function nearEnd(box: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= NEAR_END;
}

/**
 * Keeps a scroll box pinned to its end while content grows, until the reader
 * scrolls up; scrolling back near the end resumes following.
 */
export function createFollow() {
  const [following, setFollowing] = createSignal(true, { ownedWrite: true });
  let box: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let pinned = true;
  let programmatic = false;

  function toEnd() {
    if (!box) return;
    programmatic = true;
    box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => (programmatic = false));
  }

  function onScroll() {
    if (!box || programmatic) return;
    pinned = nearEnd(box);
    setFollowing(pinned);
  }

  function attach(element: HTMLElement, content: HTMLElement) {
    box = element;
    box.addEventListener("scroll", onScroll, { passive: true });
    observer = new ResizeObserver(() => {
      if (pinned) toEnd();
    });
    observer.observe(content);
    observer.observe(element);
    toEnd();
  }

  onCleanup(() => {
    box?.removeEventListener("scroll", onScroll);
    observer?.disconnect();
  });

  return {
    attach,
    following,
    /** Jump to the latest and follow again. */
    jump() {
      pinned = true;
      setFollowing(true);
      toEnd();
    },
  };
}
