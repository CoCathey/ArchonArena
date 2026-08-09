/*eslint no-console:0 */
const fs = require('fs');
const { FabricImage, StaticCanvas } = require('../../fabricNode');
const path = require('path');
const KeyForgeHalfSizeBuild = require('./KeyForgeHalfSizeBuild');

class KeyforgeImageSource {
    async fetchImage(card, imageUrl, imagePath) {
        try {
            const response = await fetch(imageUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.promises.writeFile(imagePath, buffer);
            console.log('Downloaded image for ' + card.name + ' from ' + imageUrl);
        } catch (err) {
            console.log(`Error converting image for ${card.name}: ${err}`);
        }
    }

    getHalfSizeBuilder() {
        return KeyForgeHalfSizeBuild;
    }

    async buildGigantics(card, language, imageLangDir, imgPath) {
        console.log(`Built gigantic image for ${card.id} in ${language}`);
        const canvas = new StaticCanvas(null, { width: 300, height: 420 });
        canvas.renderOnAddRemove = false;
        const bottom = await this.loadImage(path.join(imageLangDir, card + '.png'));
        const top = await this.loadImage(path.join(imageLangDir, card + '2.png'));
        // Not chained: from v6 `rotate` and `scaleToWidth` return nothing
        // rather than the object.
        top.rotate(-90);
        top.scaleToWidth(300);
        top.set({ top: 210, left: 0 });
        bottom.rotate(-90);
        bottom.scaleToWidth(300);
        bottom.set({ top: 420, left: 0 });

        canvas.add(top);
        canvas.add(bottom);
        canvas.renderAll();
        const stream = canvas.createPNGStream();
        const out = fs.createWriteStream(imgPath);
        stream.on('data', (chunk) => {
            out.write(chunk);
        });
        stream.on('end', () => {
            canvas.dispose();
        });
    }

    loadImage(imgPath) {
        return FabricImage.fromURL(`file://${imgPath}`);
    }
}

module.exports = KeyforgeImageSource;
