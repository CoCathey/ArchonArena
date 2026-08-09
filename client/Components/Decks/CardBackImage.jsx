import React, { useCallback, useEffect, useRef } from 'react';
import { StaticCanvas } from 'fabric';

import { buildCardBack } from '../../archonMaker';

const CardBackImage = ({ className = 'block h-full w-full', deck, showDeckName = true, size }) => {
    const fabricRef = useRef();
    const setCanvasRef = useCallback((node) => {
        if (!node) {
            if (fabricRef.current) {
                fabricRef.current.dispose();
                fabricRef.current = null;
            }
            return;
        }

        if (!fabricRef.current) {
            try {
                fabricRef.current = new StaticCanvas(node);
                fabricRef.current.renderOnAddRemove = false;
            } catch {
                fabricRef.current = null;
            }
        }
    }, []);

    useEffect(() => {
        const canvas = fabricRef.current;
        if (!canvas || !deck) {
            return;
        }

        canvas.clear();
        (async () => {
            try {
                await buildCardBack(canvas, deck, size, showDeckName);
            } catch {
                // ignore
            }
        })();
    }, [deck?.name, deck?.uuid, showDeckName, size, deck]);

    return <canvas className={className} ref={setCanvasRef} />;
};

export default CardBackImage;
