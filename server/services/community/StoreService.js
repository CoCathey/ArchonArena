const logger = require('../../log');
const { isValidCountry } = require('../rating/regions');

/**
 * Local game stores / venues for in-person play (Phase 9, Play IRL).
 * Community-contributed, like an open directory: anyone signed in can add
 * a store; the person who added it (or a site admin) can remove it.
 */
class StoreService {
    constructor(db = require('../../db')) {
        this.db = db;
    }

    sanitize(value, maxLength) {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim().slice(0, maxLength);

        return trimmed.length > 0 ? trimmed : null;
    }

    async create(actorId, options = {}) {
        const name = this.sanitize(options.name, 80);

        if (!name || name.length < 2) {
            return { success: false, message: 'Store name must be 2-80 characters' };
        }

        const country = options.country ? String(options.country).toUpperCase().trim() : null;

        if (country && !isValidCountry(country)) {
            return { success: false, message: 'Unknown country' };
        }

        const rows = await this.db.query(
            'INSERT INTO "Stores" ' +
                '("Name", "Country", "State", "City", "Address", "Website", "Description", "AddedByUserId", "CreatedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() AT TIME ZONE \'utc\') RETURNING "Id"',
            [
                name,
                country,
                country ? this.sanitize(options.state, 60) : null,
                this.sanitize(options.city, 80),
                this.sanitize(options.address, 200),
                this.sanitize(options.website, 200),
                this.sanitize(options.description, 1000),
                actorId
            ]
        );

        logger.info(`Store ${rows[0].Id} '${name}' added by user ${actorId}`);

        return { success: true, id: rows[0].Id };
    }

    async list({ query, country, state } = {}) {
        const params = [];
        const conditions = [];

        if (query) {
            params.push(`%${query}%`);
            conditions.push(
                `(s."Name" ILIKE $${params.length} OR s."City" ILIKE $${params.length})`
            );
        }

        if (country) {
            params.push(String(country).toUpperCase());
            conditions.push(`s."Country" = $${params.length}`);
        }

        if (state) {
            params.push(String(state).trim());
            conditions.push(`s."State" ILIKE $${params.length}`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = await this.db.query(
            'SELECT s."Id", s."Name", s."Country", s."State", s."City", s."Address", ' +
                's."Website", s."Description", s."AddedByUserId" ' +
                `FROM "Stores" s ${where} ` +
                'ORDER BY s."Country" NULLS LAST, s."State" NULLS LAST, s."Name" LIMIT 200',
            params
        );

        return (rows || []).map((row) => this.mapStore(row));
    }

    mapStore(row) {
        return {
            id: row.Id,
            name: row.Name,
            country: row.Country,
            state: row.State,
            city: row.City,
            address: row.Address,
            website: row.Website,
            description: row.Description,
            addedByUserId: row.AddedByUserId
        };
    }

    async remove(id, actor) {
        const rows = await this.db.query('SELECT * FROM "Stores" WHERE "Id" = $1', [id]);
        const store = rows && rows[0];

        if (!store) {
            return { success: false, message: 'No such store' };
        }

        if (store.AddedByUserId !== actor.id && !actor.permissions?.isAdmin) {
            return {
                success: false,
                message: 'Only the person who added it (or an admin) can remove it'
            };
        }

        await this.db.query('DELETE FROM "Stores" WHERE "Id" = $1', [id]);

        return { success: true };
    }
}

module.exports = StoreService;
