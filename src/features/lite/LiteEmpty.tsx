import { LiteIcon, type LiteIconName } from "./LiteIcon";

export function LiteEmpty({ icon, title, description }: { icon: LiteIconName; title: string; description?: string }) {
  return <div className="lite-empty"><span><LiteIcon name={icon} /></span><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}
