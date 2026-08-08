import { useRef } from 'react';
import { PanResponder } from 'react-native';

/** How far a finger must travel before a swipe counts. */
const SWIPE_THRESHOLD = 24;

/**
 * Pan handlers that fire on a deliberate vertical flick and let everything else
 * through. The responder is only claimed once the gesture is clearly vertical,
 * so taps still press, horizontal card strips still scroll, and card drags
 * (which start from the card itself) are unaffected.
 */
export function useVerticalSwipe(handlers: { onUp?: () => void; onDown?: () => void }) {
    // Handlers change every render; keep the responder itself stable so a
    // state patch arriving mid-gesture cannot cancel it.
    const latest = useRef(handlers);
    latest.current = handlers;

    return useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_event, gesture) => {
                if (Math.abs(gesture.dy) < SWIPE_THRESHOLD) {
                    return false;
                }
                if (Math.abs(gesture.dy) <= Math.abs(gesture.dx)) {
                    return false;
                }
                return gesture.dy < 0 ? !!latest.current.onUp : !!latest.current.onDown;
            },
            onPanResponderRelease: (_event, gesture) => {
                if (Math.abs(gesture.dy) < SWIPE_THRESHOLD) {
                    return;
                }
                if (gesture.dy < 0) {
                    latest.current.onUp?.();
                } else {
                    latest.current.onDown?.();
                }
            },
            onPanResponderTerminationRequest: () => false
        })
    ).current.panHandlers;
}
