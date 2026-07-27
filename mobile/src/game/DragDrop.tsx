import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '../theme';
import { CARD_ASPECT, CARDBACK, cardImageUrl } from './cardImages';
import { canDropCard, type DropZoneName } from './dragRules';
import type { CardSummary } from './types';

export { canDragCard, canDropCard, type DropZoneName } from './dragRules';

/**
 * Drag-and-drop for cards, built on the core responder system (no native
 * gesture dependencies). Cards start a drag on a mostly-vertical pan (taps
 * and horizontal strip scrolling keep working), a ghost of the card follows
 * the finger, and registered drop zones highlight when they can accept it.
 *
 * The zone names and rules mirror the web client exactly
 * (client/Components/GameBoard/Droppable.jsx): a successful drop emits the
 * same `drop` game message with (card uuid, source, target), which the
 * server resolves as playing/discarding in normal play or a free move in
 * manual mode.
 */

interface DragState {
    card: CardSummary;
    source: DropZoneName;
}

interface ZoneRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface DragDropContextValue {
    enabled: boolean;
    manualMode: boolean;
    dragging?: DragState;
    activeZone?: DropZoneName;
    registerZone: (name: DropZoneName, ref: React.RefObject<View | null>) => () => void;
    beginDrag: (card: CardSummary, source: DropZoneName, x: number, y: number) => void;
    moveDrag: (x: number, y: number) => void;
    endDrag: (x: number, y: number) => void;
    cancelDrag: () => void;
}

const DragDropContext = createContext<DragDropContextValue | undefined>(undefined);

export function useDragDrop(): DragDropContextValue | undefined {
    return useContext(DragDropContext);
}

const GHOST_WIDTH = 84;
const GHOST_HEIGHT = Math.round(GHOST_WIDTH * CARD_ASPECT);

export function DragDropProvider(props: {
    enabled: boolean;
    manualMode: boolean;
    onDrop: (card: CardSummary, source: DropZoneName, target: DropZoneName) => void;
    onDragActiveChange?: (active: boolean) => void;
    children: React.ReactNode;
}) {
    const containerRef = useRef<View>(null);
    // Window-coordinate offset of our own container, captured at drag start,
    // so finger positions (window coords) can place the absolutely-positioned
    // ghost correctly.
    const originRef = useRef({ x: 0, y: 0 });
    const zonesRef = useRef(new Map<DropZoneName, React.RefObject<View | null>>());
    const rectsRef = useRef(new Map<DropZoneName, ZoneRect>());
    const [drag, setDrag] = useState<DragState | undefined>();
    const [activeZone, setActiveZone] = useState<DropZoneName | undefined>();
    const [ghostPos, setGhostPos] = useState({ x: 0, y: 0 });
    const dragRef = useRef<DragState | undefined>(undefined);
    const activeZoneRef = useRef<DropZoneName | undefined>(undefined);

    const { onDrop, onDragActiveChange, manualMode, enabled } = props;

    const registerZone = useCallback(
        (name: DropZoneName, ref: React.RefObject<View | null>) => {
            zonesRef.current.set(name, ref);
            return () => {
                if (zonesRef.current.get(name) === ref) {
                    zonesRef.current.delete(name);
                }
            };
        },
        []
    );

    const zoneAt = useCallback((x: number, y: number): DropZoneName | undefined => {
        let found: DropZoneName | undefined;
        let smallest = Number.POSITIVE_INFINITY;
        for (const [name, rect] of rectsRef.current) {
            if (
                x >= rect.x &&
                x <= rect.x + rect.width &&
                y >= rect.y &&
                y <= rect.y + rect.height
            ) {
                // Prefer the smallest hit rect so pile chips win over the
                // full-width rows behind them.
                const area = rect.width * rect.height;
                if (area < smallest) {
                    smallest = area;
                    found = name;
                }
            }
        }
        return found;
    }, []);

    const beginDrag = useCallback(
        (card: CardSummary, source: DropZoneName, x: number, y: number) => {
            const state = { card, source };
            dragRef.current = state;
            activeZoneRef.current = undefined;
            rectsRef.current.clear();
            containerRef.current?.measureInWindow((cx, cy) => {
                originRef.current = { x: cx, y: cy };
            });
            for (const [name, ref] of zonesRef.current) {
                ref.current?.measureInWindow((zx, zy, width, height) => {
                    rectsRef.current.set(name, { x: zx, y: zy, width, height });
                });
            }
            setDrag(state);
            setActiveZone(undefined);
            setGhostPos({ x, y });
            onDragActiveChange?.(true);
        },
        [onDragActiveChange]
    );

    const moveDrag = useCallback(
        (x: number, y: number) => {
            if (!dragRef.current) {
                return;
            }
            setGhostPos({ x, y });
            const zone = zoneAt(x, y);
            if (zone !== activeZoneRef.current) {
                activeZoneRef.current = zone;
                setActiveZone(zone);
            }
        },
        [zoneAt]
    );

    const finishDrag = useCallback(() => {
        dragRef.current = undefined;
        activeZoneRef.current = undefined;
        setDrag(undefined);
        setActiveZone(undefined);
        onDragActiveChange?.(false);
    }, [onDragActiveChange]);

    const endDrag = useCallback(
        (x: number, y: number) => {
            const state = dragRef.current;
            if (!state) {
                return;
            }
            const zone = zoneAt(x, y);
            if (zone && canDropCard(state.card, state.source, zone, manualMode)) {
                onDrop(state.card, state.source, zone);
            }
            finishDrag();
        },
        [zoneAt, manualMode, onDrop, finishDrag]
    );

    const value = useMemo<DragDropContextValue>(
        () => ({
            enabled,
            manualMode,
            dragging: drag,
            activeZone,
            registerZone,
            beginDrag,
            moveDrag,
            endDrag,
            cancelDrag: finishDrag
        }),
        [
            enabled,
            manualMode,
            drag,
            activeZone,
            registerZone,
            beginDrag,
            moveDrag,
            endDrag,
            finishDrag
        ]
    );

    const ghostUrl = drag && !drag.card.facedown ? cardImageUrl(drag.card) : undefined;

    return (
        <DragDropContext.Provider value={value}>
            <View ref={containerRef} style={{ flex: 1 }} collapsable={false}>
                {props.children}
                {drag ? (
                    <View
                        pointerEvents='none'
                        style={[
                            styles.ghost,
                            {
                                left: ghostPos.x - originRef.current.x - GHOST_WIDTH / 2,
                                top: ghostPos.y - originRef.current.y - GHOST_HEIGHT - 14
                            }
                        ]}
                    >
                        <Image
                            source={ghostUrl ? { uri: ghostUrl } : CARDBACK}
                            style={styles.ghostImage}
                            contentFit='cover'
                        />
                    </View>
                ) : null}
            </View>
        </DragDropContext.Provider>
    );
}

/**
 * Wraps a view so it accepts card drops under `name`. While a drag is in
 * flight the zone shows an affordance when it can accept the card and lights
 * up while the finger is over it.
 */
export function DropZone(props: {
    name: DropZoneName;
    style?: ViewStyle | ViewStyle[];
    children: React.ReactNode;
}) {
    const context = useDragDrop();
    const ref = useRef<View>(null);
    const registerZone = context?.registerZone;

    useEffect(() => {
        if (!registerZone) {
            return;
        }
        return registerZone(props.name, ref);
    }, [registerZone, props.name]);

    const drag = context?.dragging;
    const eligible =
        !!drag && canDropCard(drag.card, drag.source, props.name, context?.manualMode ?? false);
    const hovered = eligible && context?.activeZone === props.name;

    return (
        <View
            ref={ref}
            collapsable={false}
            style={[
                props.style as ViewStyle,
                eligible ? styles.eligible : undefined,
                hovered ? styles.hovered : undefined
            ]}
        >
            {props.children}
        </View>
    );
}

const styles = StyleSheet.create({
    ghost: {
        position: 'absolute',
        width: GHOST_WIDTH,
        height: GHOST_HEIGHT,
        borderRadius: 6,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: colors.brand,
        shadowColor: '#000',
        shadowOpacity: 0.6,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
        zIndex: 1000
    },
    ghostImage: {
        width: '100%',
        height: '100%'
    },
    eligible: {
        borderColor: colors.selectable,
        borderWidth: 1,
        borderRadius: 8,
        borderStyle: 'dashed'
    },
    hovered: {
        borderColor: colors.brand,
        borderWidth: 2,
        borderStyle: 'solid',
        backgroundColor: 'rgba(232, 163, 61, 0.12)'
    }
});
