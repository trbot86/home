(async () => (await Capacitor.Plugins.Household.invoke({ method: 'state', args: {} })).value)()
