<div align="center">

![Universidade Portucalense](logo_upt.png)

[upt.pt](https://upt.pt)

</div>

# Trabalho de Sistemas Distribuídos

<!-- Campos da capa sem valor no original: Curso | Ano letivo | Ano do Curso | Unidade Curricular | Nome do Docente -->

- Afonso Calisto · 48096
- Guilherme Russo · 47653
- Duarte Ferreira · 47784
- Ronaldo Leal · 47564

---

## Resumo

Este projeto propõe a implementação de uma base de dados chave-valor distribuída utilizando o ecossistema Node.js. O sistema divide os dados entre múltiplos nós (sharding) e garante tolerância a falhas e consistência forte por meio do protocolo Raft e do protocolo de dois fases (2PC - Two-Phase Commit). Cada par chave-valor é armazenado como um ficheiro no sistema de ficheiros, sendo o nome do ficheiro o hash MD5 da chave. A arquitetura foi concebida para escalar horizontalmente e para lidar com falhas de servidores individuais sem comprometer a integridade dos dados. A solução inclui um *reverse proxy* responsável por distribuir pedidos para os nós corretos com base na hash da chave. Esta abordagem permite um controlo preciso da responsabilidade de cada nó, ao mesmo tempo que assegura coordenação eficaz entre réplicas através do consenso distribuído. O relatório detalha a implementação, os mecanismos de robustez adotados, e também aponta limitações e possíveis melhorias para trabalhos futuros.

---

## Índice
- [1. Introdução](#1-introdução)
- [2. Arquitetura da Solução](#2-arquitetura-da-solução)
  - [Componentes principais](#componentes-principais)
  - [Armazenamento](#armazenamento)
  - [Inicialização](#inicialização)
- [3. Robustez da Solução Distribuída](#3-robustez-da-solução-distribuída)
- [4. Problemas Não Resolvidos](#4-problemas-não-resolvidos)
  - [4.1 Formato Inconsistente das Respostas de Erro](#41-formato-inconsistente-das-respostas-de-erro)
  - [4.2 Rotas Mal Definidas ou Incompletas](#42-rotas-mal-definidas-ou-incompletas)
- [5. Conclusões](#5-conclusões)
- [6. Bibliografia](#6-bibliografia)

---

## 1. Introdução

A necessidade por soluções escaláveis e tolerantes a falhas levou ao desenvolvimento de bases de dados distribuídas, em particular as do tipo chave-valor. Este projeto teve como objetivo criar uma solução funcional, capaz de distribuir dados entre múltiplos nós e manter consistência mesmo em caso de falhas parciais.

O projeto visa explorar, de forma prática, conceitos fundamentais de sistemas distribuídos como partição de dados (*sharding*), consenso distribuído e coordenação entre réplicas.

## 2. Arquitetura da Solução

### Componentes principais:

- **Reverse Proxy**  
  Implementado em Express, é o ponto central de entrada no sistema. Determina o *data node* responsável com base no hash da chave (MD5) e redireciona o pedido. Também mantém o registo dos nós ativos.
- **Data Nodes**  
  Cada *data node* representa uma partição da base de dados e executa múltiplas instâncias de *serverDB*. O *data node* expõe APIs REST para leitura, criação, atualização e remoção de dados.
- **ServerDB**  
  Responsável pelo armazenamento local dos dados (em ficheiros), eleição de líder com Raft e replicação com 2PC. Cada instância é identificada por ID e porta, e está associada a um diretório de dados.
- **Raft**  
  Implementado manualmente. Realiza eleição de líder entre servidores do mesmo nó. O líder é o único autorizado a realizar escritas.
- **2PC (Two-Phase Commit)**  
  Garante que todas as réplicas apliquem operações de forma consistente. Inclui fase de preparação e fase de commit, com rollback implícito em caso de falha.

### Armazenamento:

Cada par chave-valor é salvo como um ficheiro com o nome baseado no hash MD5 da chave. O conteúdo é serializado em JSON.

### Inicialização:

A ferramenta beeDB.js permite iniciar, parar, reiniciar, consultar estado e estatísticas, e limpar dados do sistema.

## 3. Robustez da Solução Distribuída

A robustez do sistema é garantida por diversas camadas:

- **Eleições de líder com Raft**  
  Cada grupo de servidores num nó realiza eleições periodicamente. O servidor líder envia *heartbeats* para manter sua autoridade.
- **Failover automático**  
  Quando o líder falha, uma nova eleição é iniciada automaticamente. O sistema deteta essa falha via ausência de *heartbeat*.
- **2PC nas operações críticas**  
  Antes de aplicar uma mudança de estado (escrita, atualização ou eliminação), o líder verifica se todas as réplicas estão prontas (fase prepare). Após aprovação, envia comando de commit.
- **Logs estruturados e monitorização**  
  Todos os eventos são registados com contexto (ID do nó, estado do Raft, tipo de erro). O reverse proxy expõe /status e /stats para inspeção.
- **Encerramento limpo e forçado**  
  O sistema trata sinais (SIGINT, SIGTERM) e permite desligamento limpo, ou forçado após tempo limite.

## 4. Problemas Não Resolvidos

Apesar da implementação funcional da maioria dos componentes, foram identificadas limitações relevantes:

### 4.1 Formato Inconsistente das Respostas de Erro

As respostas de erro não seguem um padrão uniforme, misturando informações contextuais com os próprios dados de erro. Essa inconsistência dificulta a automação do tratamento de falhas e compromete a clareza das APIs REST. Recomenda-se adotar um formato padronizado com campos como code, message, timestamp e context.

### 4.2 Rotas Mal Definidas ou Incompletas

Algumas rotas referenciadas na documentação — como /election, /maintenance, /any-other-needed, /admin e /admin/loglevel — não possuíam especificações claras sobre métodos, parâmetros ou comportamento esperado. Isso inviabilizou a sua implementação e levou à suspensão de funcionalidades dependentes. A ausência de documentação técnica adequada também dificultou testes e integrações.

## 5. Conclusões

O projeto *beeDB* demonstra com sucesso como construir uma base de dados distribuída funcional com tolerância a falhas, utilizando apenas o ecossistema Node.js. A separação em componentes claros (proxy, nós, servidores, Raft) facilitou a modularização e teste da solução.

A escolha por MD5 para hashing foi eficaz para o sharding, e o uso do sistema de ficheiros local simplificou o armazenamento. A integração entre Raft e 2PC permitiu garantir consistência forte entre réplicas.

O desenvolvimento manual dos protocolos permitiu entender profundamente os desafios dos sistemas distribuídos, incluindo consenso, falhas parciais e coordenação.

Como trabalho futuro, propõe-se:

- Implementação completa de Raft com logs e persistência.
- Suporte a reconfiguração dinâmica.
- Implementação de snapshots e compactação de estado.
- Introdução de autenticação, segurança e testes de carga.

## 6. Bibliografia

- Ongaro, D., & Ousterhout, J. (2014). *In Search of an Understandable Consensus Algorithm (Raft)*. USENIX.
- Tanenbaum, A. S., & van Steen, M. (2007). *Distributed Systems: Principles and Paradigms*. Prentice Hall.
- Node.js Official Docs – [https://nodejs.org](https://nodejs.org)
- Winston Logger – [https://github.com/winstonjs/winston](https://github.com/winstonjs/winston)
- MDN Web Docs – [https://developer.mozilla.org](https://developer.mozilla.org)
- RFC 5046 – Two-Phase Commit Protocol
- Documentação oficial da UC de Sistemas Distribuídos – 2025
