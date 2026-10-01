/**
 * One short, subtle tap at the moment of first contact — never while moving.
 *
 * Progressive enhancement:
 *  - Vibration API where it exists (Android).
 *  - iOS 18+ Safari has no Vibration API but plays a system haptic when an
 *    `<input type="checkbox" switch>` is toggled; toggling a hidden one through
 *    its label is the only web-reachable haptic there. Best effort: if the
 *    platform ignores it, nothing happens.
 *  - Everything else: silently nothing.
 */

let iosSwitch: HTMLLabelElement | null = null;

const isAppleTouch = (): boolean =>
  /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function iosHapticLabel(): HTMLLabelElement {
  if (!iosSwitch) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  return iosSwitch;
}

export function hapticTap(pointerType: string): void {
  if (pointerType !== 'touch') return;
  // Browsers refuse (and log) vibration before the page has had a user activation;
  // the very first touch of a session therefore stays silent to the hand.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    } else if (isAppleTouch()) {
      iosHapticLabel().click();
    }
  } catch {
    /* haptics are an enhancement; never let them interrupt playing */
  }
}

export function disposeHaptics(): void {
  iosSwitch?.remove();
  iosSwitch = null;
}
