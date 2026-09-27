import type { TaskTemplate } from '../tasks/task-template.js';
export type MaintenanceIdea = {
  id: string;
  category: string;
  title: string;
  instructions: string;
  timing: string;
  source: { title: string; url: string; checkedOn: string };
};
// Optional starting points, never automatic schedules or a model-specific service plan.
const checkedOn = '2026-09-27';
const bosch = {
  title: 'Bosch dishwasher care',
  url: 'https://www.bosch-home.com/us/owner-support/dishwashers/cleaning-maintenance',
  checkedOn,
};
export const maintenanceIdeas: readonly MaintenanceIdea[] = [
  {
    id: 'heating-filter-check',
    category: 'Heating & cooling',
    title: 'Check the heating filter',
    instructions:
      'Inspect the filter and note its condition, size and type. Follow the equipment manual for cleaning or replacement; buying a spare is separate from installing it.',
    timing:
      'The US Department of Energy suggests a monthly filter check during heating use. Follow your equipment and filter instructions for replacement.',
    source: {
      title: 'US Department of Energy: heating filters',
      url: 'https://www.energy.gov/articles/5-tips-help-you-save-energy-bills-winter',
      checkedOn,
    },
  },
  {
    id: 'dishwasher-filter',
    category: 'Kitchen',
    title: 'Clean the dishwasher filter',
    instructions:
      'Use the model manual to identify and clean the removable filter, then refit it securely. Record any damage or persistent debris.',
    timing:
      'Bosch suggests cleaning its dishwasher filters every few months. Check the instructions for your model and usage.',
    source: bosch,
  },
  {
    id: 'dishwasher-spray-arms',
    category: 'Kitchen',
    title: 'Check the dishwasher spray arms',
    instructions:
      'Check the spray-arm openings for debris and clean them using the model manual. Confirm that the arms can turn freely after refitting.',
    timing:
      'Bosch suggests cleaning spray arms every few months. Adapt this to your model and water conditions.',
    source: bosch,
  },
  {
    id: 'washer-cleaning',
    category: 'Laundry',
    title: 'Clean the washing machine',
    instructions:
      'Follow the washer manual for its empty cleaning cycle, approved cleaning product and dispenser care. Note any odours or residue afterward.',
    timing:
      'Whirlpool suggests cleaning every 30 days or 30 wash cycles. The app tracks time after completion, not laundry cycles; choose a schedule that fits your use.',
    source: {
      title: 'Whirlpool washing-machine care',
      url: 'https://www.whirlpool.com/blog/washers-and-dryers/clean-washing-machine.html',
      checkedOn,
    },
  },
  {
    id: 'fridge-seal-check',
    category: 'Kitchen',
    title: 'Inspect refrigerator door seals',
    instructions:
      'Inspect the door seals for damage and gaps. Use the model manual for cleaning and adjustment, and note anything that needs repair.',
    timing:
      'Whirlpool lists yearly seal inspection and monthly gasket cleaning. Keep those as separate tasks if both would help.',
    source: {
      title: 'Whirlpool refrigerator maintenance',
      url: 'https://producthelp.whirlpool.com/Refrigeration/Full-Size_Refrigerators/Product_Info/Cleaning_and_Care/Preventative_Maintenance_for_Refrigerators',
      checkedOn,
    },
  },
];
export const maintenanceTaskTemplate = (idea: MaintenanceIdea): TaskTemplate => ({
  id: `maintenance:${idea.id}`,
  title: idea.title,
  instructions: idea.instructions,
  maintenanceReference: `${idea.timing}\n${idea.source.title}\n${idea.source.url}`,
});
