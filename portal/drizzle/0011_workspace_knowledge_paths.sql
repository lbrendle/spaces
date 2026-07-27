UPDATE `knowledge_pages`
   SET `source_label` = 'Workspace knowledge'
 WHERE `source_type` = 'portal' AND `source_label` = '';
--> statement-breakpoint
UPDATE `knowledge_pages`
   SET `path` =
     replace(replace(trim(`title`), '/', '-'), char(92), '-') || '.md'
 WHERE `source_type` = 'portal' AND trim(`path`) = '';
