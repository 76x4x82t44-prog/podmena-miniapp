-- Commit this migration before using the new enum member in a constraint.
alter type podmena.shift_status add value if not exists 'needs_replacement';
