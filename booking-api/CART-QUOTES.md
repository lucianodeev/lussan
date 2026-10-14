# Carrinho e orçamentos

Todos os atendimentos presenciais são feitos pela dupla. Massagem: 30 min €80, 60 min €150, 90 min €225, 120 min €300. Viagens para outra cidade/país exigem 120 min de massagem, com pacote da dupla a partir de €400 + transporte. A tarifa no local para 120 min continua €300. Depilação acrescenta uma margem de agenda de 30 minutos por zona; pernas completas, 60 minutos.

No local: total do catálogo e pagamento imediato; horário reservado para todos os serviços presenciais. Conversas são combinadas pelo WhatsApp. Fotos: entrega manual em até três dias após pagamento.

No endereço em Bruxelas: proposta de deslocação de €25 por visita, sujeita a confirmação da disponibilidade e endereço. Novos pedidos de viagem: pacote de 120 minutos €400 + transporte ida/volta para dois. Não acrescentar automaticamente hospedagem nem tarifa por hora de deslocação. Orçamentos antigos preservam seus valores. Os valores apresentados pelo cliente são apenas orçamentos indicativos e não autorizam uma cobrança. Não existe integração de emissão de bilhetes ou reserva de hotel.

## Aprovação manual pelo proprietário

1. O cliente envia a solicitação pelo botão WhatsApp, incluindo a referência e o link privado. Essa mensagem está identificada como ainda não paga.
2. Conferir endereço, datas, disponibilidade da dupla e preços reais de transporte/hotel, incluindo bagagens, transferes e taxas. Confirmar os dias necessários para ida e volta. Bloquear previamente os dias de viagem adicionais na agenda existente quando necessário.
3. No Shell/SSH do serviço Render `lussan-booking-api`, usar a ligação DATABASE_URL já configurada, sem copiar credenciais:

   `node booking-api/approve-quote.js --id UUID --transport 160`

   Isso apenas apresenta o orçamento: pacote €400 + €160 transporte para dois = €560, sem serviços adicionais. O transporte é um exemplo e deve ser substituído pelo custo confirmado. Novos pedidos não aceitam --hotel ou --travel-hours com valores adicionais.
4. Após verificar o total e confirmar disponibilidade, executar o mesmo comando com `--confirm`. Para Bruxelas, basta `--id UUID --confirm`; o adicional é €25.
5. Enviar ao cliente o link privado original. O botão de pagar fica disponível por 24 horas. O cliente paga um checkout com todos os serviços e custos discriminados. O proprietário compra as passagens/reserva hotel depois de receber.

Alternativa: um administrador autorizado pode atualizar o orçamento pelo SQL Editor do Supabase com a mesma validação. Nunca disponibilizar chaves de serviço, DATABASE_URL ou um endpoint público de aprovação.

## Confirmação e agenda

O servidor calcula preços de catálogo, ignora valores enviados pelo cliente e valida custos aprovados antes de criar Stripe Checkout. Um webhook com assinatura válida, modo correto, moeda EUR e total exato confirma pedido e agenda atomicamente. O retorno ao site abre WhatsApp apenas após essa confirmação.

Deslocações locais incluem 30 minutos antes e depois do atendimento na agenda. Viagens reservam o dia completo do atendimento; os dias adicionais de ida/volta devem ser bloqueados pelo proprietário antes de aprovar. Expiração/falha assíncrona do checkout cancela apenas reservas ainda pendentes.

O link do orçamento contém um token aleatório de acesso; tratar como privado. Não contém endereço nem contacto do cliente na URL. As tabelas são privadas e protegidas por RLS, sem acesso anon/authenticated.

## Pacotes até 100 km de Bruxelas

Na lista do mesmo formulário: `travel_120` 2h €400; `travel_180` 3h €600; `travel_240` 4h €800; `travel_300` 5h €1.000; `travel_360` 6h €1.200. Preço da dupla, mais transporte ida/volta para dois. Apenas um pacote de atendimento pode ser escolhido por pedido; extras como depilação continuam disponíveis.

Confirmar a distância do endereço antes de aprovar esses pacotes. Exemplo: `node booking-api/approve-quote.js --id UUID --transport 100 --distance-km 80` para apresentar; adicionar `--confirm` para aprovar. Distância máxima 100 km de Bruxelas; valores fora desse limite são recusados. Outros destinos exigem orçamento personalizado. Reservar a duração real do pacote na agenda, acrescida dos serviços presenciais adicionais.
