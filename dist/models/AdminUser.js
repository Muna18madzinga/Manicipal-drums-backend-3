"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminUserModel = exports.AdminRole = void 0;
const uuid_1 = require("uuid");
var AdminRole;
(function (AdminRole) {
    AdminRole["SUPER_ADMIN"] = "super_admin";
    AdminRole["DATA_MANAGER"] = "data_manager";
    AdminRole["STYLE_MANAGER"] = "style_manager";
    AdminRole["VIEWER"] = "viewer";
})(AdminRole || (exports.AdminRole = AdminRole = {}));
class AdminUserModel {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async findByUserId(userId) {
        const query = `
      SELECT id, user_id, role, permissions, created_at, updated_at, last_login, is_active
      FROM admin_users
      WHERE user_id = $1 AND is_active = true
    `;
        const result = await this.pool.query(query, [userId]);
        return result.rows[0] || null;
    }
    async findById(id) {
        const query = `
      SELECT id, user_id, role, permissions, created_at, updated_at, last_login, is_active
      FROM admin_users
      WHERE id = $1 AND is_active = true
    `;
        const result = await this.pool.query(query, [id]);
        return result.rows[0] || null;
    }
    async create(userData) {
        const id = (0, uuid_1.v4)();
        const permissions = userData.permissions || this.getDefaultPermissions(userData.role);
        const query = `
      INSERT INTO admin_users (id, user_id, role, permissions)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_id, role, permissions, created_at, updated_at, last_login, is_active
    `;
        const result = await this.pool.query(query, [id, userData.user_id, userData.role, permissions]);
        return result.rows[0];
    }
    async updateLastLogin(id) {
        const query = `
      UPDATE admin_users
      SET last_login = NOW()
      WHERE id = $1
    `;
        await this.pool.query(query, [id]);
    }
    async updateRole(id, role, permissions) {
        const newPermissions = permissions || this.getDefaultPermissions(role);
        const query = `
      UPDATE admin_users
      SET role = $2, permissions = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, role, permissions, created_at, updated_at, last_login, is_active
    `;
        const result = await this.pool.query(query, [id, role, newPermissions]);
        return result.rows[0];
    }
    async deactivate(id) {
        const query = `
      UPDATE admin_users
      SET is_active = false, updated_at = NOW()
      WHERE id = $1
    `;
        await this.pool.query(query, [id]);
    }
    async getAll() {
        const query = `
      SELECT id, user_id, role, permissions, created_at, updated_at, last_login, is_active
      FROM admin_users
      ORDER BY created_at DESC
    `;
        const result = await this.pool.query(query);
        return result.rows;
    }
    getDefaultPermissions(role) {
        switch (role) {
            case AdminRole.SUPER_ADMIN:
                return {
                    all: true,
                    data: { create: true, read: true, update: true, delete: true },
                    styles: { create: true, read: true, update: true, delete: true },
                    users: { create: true, read: true, update: true, delete: true },
                    validation: { create: true, read: true, update: true, delete: true },
                    audit: { read: true }
                };
            case AdminRole.DATA_MANAGER:
                return {
                    data: { create: true, read: true, update: true, delete: true },
                    validation: { read: true, update: true },
                    audit: { read: true }
                };
            case AdminRole.STYLE_MANAGER:
                return {
                    styles: { create: true, read: true, update: true, delete: true },
                    audit: { read: true }
                };
            case AdminRole.VIEWER:
                return {
                    data: { read: true },
                    styles: { read: true },
                    validation: { read: true },
                    audit: { read: true }
                };
            default:
                return {};
        }
    }
    async hasPermission(userId, permission) {
        const adminUser = await this.findByUserId(userId);
        if (!adminUser || !adminUser.is_active) {
            return false;
        }
        // Super admin has all permissions
        if (adminUser.role === AdminRole.SUPER_ADMIN) {
            return true;
        }
        // Check specific permission
        const permissionPath = permission.split('.');
        let current = adminUser.permissions;
        for (const part of permissionPath) {
            if (current[part] === true) {
                return true;
            }
            if (current[part] === undefined || current[part] === false) {
                return false;
            }
            current = current[part];
        }
        return false;
    }
}
exports.AdminUserModel = AdminUserModel;
//# sourceMappingURL=AdminUser.js.map