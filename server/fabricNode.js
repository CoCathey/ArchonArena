/**
 * ARCHON: the server's one way in to Fabric.
 *
 * Two things have to be true of every server-side Fabric import, and neither is
 * true of `require('fabric')`:
 *
 *  - it has to be the node build. From v6 the package ships a browser build and
 *    a node build behind separate entry points, and the default one reaches for
 *    `document`.
 *
 *  - objects have to default to a top-left origin. Fabric 7 made `center` the
 *    default; through Fabric 5 it was the top-left corner. Every coordinate in
 *    the card image builders is written against top-left - and several of them
 *    set `originX: 'center'` while relying on `originY` staying `top`, so the
 *    new default does not merely shift things, it silently reinterprets what
 *    those call sites asked for.
 *
 * Requiring this module rather than `fabric/node` directly is what stops the
 * second one from being re-broken by the next file that needs to draw.
 */
const fabric = require('fabric/node');

fabric.FabricObject.ownDefaults.originX = 'left';
fabric.FabricObject.ownDefaults.originY = 'top';

module.exports = fabric;
