def legacy_entry(value):
    return value + 1


class LegacyRunner:
    def run(self):
        return legacy_entry(1)
