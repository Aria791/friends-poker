-- =============================================================================
-- D1 建表脚本（Friends Poker）
-- 由 wrangler.jsonc 的 migrations_dir (./migrations) 指向；部署后执行：
--   wrangler d1 migrations apply friends-poker-d1 --remote
-- =============================================================================
--
-- 架构说明（重要）：本项目有「两层存储」，不要混为一谈：
--   A) D1（绑定名 DB，全局唯一）：仅用于跨房间的房间列表展示，见下方 rooms 表，
--      由 src/worker/router.ts 通过 env.DB 读写（GET /api/rooms、POST /api/rooms）。
--   B) Durable Object 内置 SQLite（绑定名 ROOM，每个房间一个实例）：
--      kv / hand_initial / actions / chat 四张表都建在「每个房间自己的 DO」里，
--      由 src/room/storage.ts 的 initSchema() 在运行时自动 CREATE TABLE，
--      **不需要也不应该**写进 D1 迁移。
--
-- 因此：rooms 是真正被 D1 使用的表；actions 在本文件里仅为「预留/全局审计」用途，
-- 当前生产代码并未向 D1 写 actions（行动日志存于各房间 DO 内部）。若不需要全局
-- action 审计，可安全删除 actions 表；需要跨房间复盘/统计时再改造 controller 写入即可。

-- 房间列表（被 /api/rooms 使用）
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 行动日志（预留：当前生产代码将 action 存于各房间 DO 内，见 storage.ts）
-- 如需全局审计/复盘，启用本表并改造 router/controller 写入即可。
CREATE TABLE IF NOT EXISTS actions (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code    TEXT    NOT NULL,
  hand_number  INTEGER NOT NULL,
  player_id    TEXT    NOT NULL,
  action_json  TEXT    NOT NULL,
  ts           INTEGER NOT NULL
);
