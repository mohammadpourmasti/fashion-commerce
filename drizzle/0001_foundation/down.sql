-- Reverts 0001_foundation. Every DROP TABLE is preceded by a guard that
-- aborts the whole transaction if the table still holds rows.

SELECT fc_assert_table_empty('handled_events');
DROP TABLE handled_events;

SELECT fc_assert_table_empty('outbox_events');
DROP TABLE outbox_events;

DROP FUNCTION fc_app_grant(regclass, text);
DROP FUNCTION fc_assert_column_empty(regclass, text);
DROP FUNCTION fc_assert_table_empty(regclass);
