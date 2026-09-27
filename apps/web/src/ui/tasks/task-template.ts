/** Starting text for a new task. Saved drafts always take precedence over these defaults. */
export type TaskTemplate = {
  id: string;
  title: string;
  instructions: string;
  maintenanceReference: string;
};
