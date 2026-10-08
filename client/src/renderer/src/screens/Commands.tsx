import { Gauge, Network, Power, Search, Shield, Volume2, XCircle } from "lucide-react";
import { FEATURES, type SearchEngine, type UiState } from "../../../shared/types";
import { fill, useTexts } from "../i18n";
import { Card, Field, Locked, NumberInput, SwitchRow } from "../ui";

export function Commands({ state }: { state: UiState }) {
  const t = useTexts();
  const { prefs, features } = state;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t.navCommands}</h1>
          <p>{t.commandsHint}</p>
        </div>
      </div>

      <Locked locked={state.parental.enabled}>
      <Card title={t.featuresTitle} icon={<Gauge />}>
        {FEATURES.map((feature) => (
          <SwitchRow
            key={feature}
            title={t.feature[feature][0]}
            hint={t.feature[feature][1]}
            checked={features[feature]}
            onChange={(value) => window.gh.setFeatures({ [feature]: value })}
          />
        ))}
      </Card>

      <div className="grid-2">
        <Card title={t.powerTitle} icon={<Power />}>
          <SwitchRow title={t.confirmPower} hint={t.confirmPowerHint} checked={prefs.confirmPower} onChange={(confirmPower) => window.gh.setPrefs({ confirmPower })} />
          <Field label={t.countdownSec} hint={t.countdownSecHint}>
            <NumberInput value={prefs.countdownSec} min={0} max={60} onCommit={(countdownSec) => window.gh.setPrefs({ countdownSec })} />
          </Field>
        </Card>

        <Card title={t.closeTitle} icon={<XCircle />}>
          <Field label={t.forceCloseSec} hint={t.forceCloseHint}>
            <NumberInput value={prefs.forceCloseSec} min={0} max={60} onCommit={(forceCloseSec) => window.gh.setPrefs({ forceCloseSec })} />
          </Field>
        </Card>

        <Card title={t.volumeTitle} icon={<Volume2 />}>
          <Field label={t.volumeStep}>
            <NumberInput value={prefs.volumeStep} min={1} max={50} onCommit={(volumeStep) => window.gh.setPrefs({ volumeStep })} />
          </Field>
        </Card>

        <Card title={t.searchTitle} icon={<Search />}>
          <Field label={t.searchEngine}>
            <select className="select" value={prefs.searchEngine} onChange={(event) => window.gh.setPrefs({ searchEngine: event.target.value as SearchEngine })}>
              <option value="yandex">Яндекс</option>
              <option value="google">Google</option>
              <option value="bing">Bing</option>
              <option value="duckduckgo">DuckDuckGo</option>
            </select>
          </Field>
        </Card>
      </div>

      <Card title={t.privacyTitle} icon={<Shield />}>
        <SwitchRow title={t.shareRunning} hint={t.shareRunningHint} checked={prefs.shareRunning} onChange={(shareRunning) => window.gh.setPrefs({ shareRunning })} />
      </Card>
      </Locked>

      <Card title={t.wolTitle} icon={<Network />}>
        <p className="hint">{state.wol.mac ? fill(t.wolReady, { mac: state.wol.mac, adapter: state.wol.adapter ?? "" }) : t.wolUnknown}</p>
        <p className="hint">{t.wolHint}</p>
      </Card>
    </div>
  );
}
