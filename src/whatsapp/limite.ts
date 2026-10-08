/** Janela deslizante: no máximo `limite` envios a cada `janelaMs` (60 s por padrão). A vaga é reservada antes de esperar. */
export class LimitePorMinuto {
  private envios: number[] = []

  constructor(
    private readonly limite: number,
    private readonly relogio: () => number,
    private readonly esperar: (ms: number) => Promise<void>,
    private readonly janelaMs = 60_000
  ) {}

  async reservar(): Promise<void> {
    for (;;) {
      const agora = this.relogio()
      this.envios = this.envios.filter((t) => agora - t < this.janelaMs)
      if (this.envios.length < this.limite) {
        this.envios.push(agora)
        return
      }
      await this.esperar(this.envios[0]! + this.janelaMs - agora)
    }
  }
}

/**
 * Ritmo de gente, não de máquina. As ferramentas que rodam há anos em cima do WhatsApp Web
 * (Evolution API, WPPConnect, whatsapp-web.js, os guias do Baileys) convergem nas mesmas regras:
 * "digitando" antes de cada mensagem, com duração proporcional ao texto e nunca igual duas vezes;
 * intervalos irregulares entre mensagens; e tetos por minuto e por hora. Tempo fixo (sempre 1 s,
 * sempre 3 s) é o padrão mais fácil de reconhecer como robô.
 */

/** Número entre a e b (inclusive a), sorteado. */
export function sortear(a: number, b: number, aleatorio: () => number = Math.random): number {
  return Math.round(a + (b - a) * aleatorio())
}

/**
 * "Digitando..." pareado com o tamanho do texto: cada caractere leva de 30 a 60 ms (sorteado a cada
 * mensagem, como a velocidade de quem digita muda), mais uma pausa de "pensar" de 0,4 a 1,2 s.
 * Fica entre 1,2 s e 9 s: mensagem longa não segura o envio para sempre.
 */
export function duracaoDigitando(texto: string, aleatorio: () => number = Math.random): number {
  const porCaractere = 30 + 30 * aleatorio()
  const pensar = 400 + 800 * aleatorio()
  return Math.round(Math.min(9000, Math.max(1200, texto.length * porCaractere + pensar)))
}
