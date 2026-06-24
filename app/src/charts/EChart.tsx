import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { useEffect, useRef } from "react";

type Props = {
  option: EChartsOption;
  height?: number;
};

export function EChart({ option, height = 320 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
