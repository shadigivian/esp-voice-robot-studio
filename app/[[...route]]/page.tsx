import { ControlPanel } from "../../components/control-panel";

export default function Page() {
  return <ControlPanel productName={process.env.PRODUCT_NAME || undefined} />;
}
