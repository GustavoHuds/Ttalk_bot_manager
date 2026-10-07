/** Janela deslizante de 60 s: no máximo `limite` envios por minuto. A vaga é reservada antes de esperar. */
export class LimitePorMinuto {
  private envios: number[] = []

  constructor(
    private readonly limite: number,
    private readonly relogio: () => number,
    private readonly esperar: (ms: number) => Promise<void>
  ) {}

  async reservar(): Promise<void> {
    for (;;) {
      const agora = this.relogio()
      this.envios = this.envios.filter((t) => agora - t < 60_000)
      if (this.envios.length < this.limite) {
        this.envios.push(agora)
        return
      }
      await this.esperar(this.envios[0]! + 60_000 - agora)
    }
  }
}
