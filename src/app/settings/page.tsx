'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Save,
  Server,
  Sparkles,
} from 'lucide-react';

interface KeyField {
  id: string;
  label: string;
  placeholder: string;
  envKey: string;
  helpUrl?: string;
}

const KEY_FIELDS: KeyField[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    placeholder: 'sk-or-v1-...',
    envKey: 'OPENROUTER_API_KEY',
    helpUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-...',
    envKey: 'OPENAI_API_KEY',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
    envKey: 'ANTHROPIC_API_KEY',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    placeholder: 'gsk_...',
    envKey: 'GROQ_API_KEY',
    helpUrl: 'https://console.groq.com/keys',
  },
];

const OPENROUTER_MODELS = [
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', price: '$0.8/$4' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', price: '$3/$15' },
  { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', price: '$15/$75' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', price: '$0.15/$0.6' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', price: '$2.5/$10' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', price: '$0.1/$0.4' },
  { id: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro', price: '$1.25/$10' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', price: '$0.3/$0.4' },
  { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3', price: '$0.14/$0.28' },
  { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B', price: '$0.36/$0.4' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1', price: '$0.1/$0.3' },
  { id: 'z-ai/glm-5', label: 'GLM-5', price: '$1/$3.2' },
];

export default function SettingsPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [envKeys, setEnvKeys] = useState<Record<string, boolean>>({});
  const [ollamaHost, setOllamaHost] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState('anthropic/claude-3.5-haiku');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setKeys({
          openai: data.keys.openai || '',
          anthropic: data.keys.anthropic || '',
          groq: data.keys.groq || '',
          openrouter: data.keys.openrouter || '',
        });
        setOllamaHost(data.keys.ollamaHost || '');
        setOllamaModel(data.keys.ollamaModel || '');
        setOpenrouterModel(data.openrouter?.model || 'anthropic/claude-3.5-haiku');
        setEnvKeys(data.envKeys || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: {
            ...keys,
            ollamaHost: ollamaHost || undefined,
            ollamaModel: ollamaModel || undefined,
          },
          openrouter: { model: openrouterModel },
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast({ title: 'Configuración guardada' });
    } catch {
      toast({ title: 'Error al guardar', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [keys, ollamaHost, ollamaModel, openrouterModel, toast]);

  const toggleShow = (id: string) =>
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 p-3 sm:p-6 space-y-6 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h2 className="text-lg font-semibold">Configuraci&oacute;n</h2>
            <p className="text-sm text-muted-foreground">
              API keys y proveedores de IA
            </p>
          </div>
        </div>

        {/* API Keys */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Key className="h-4 w-4" />
              API Keys
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Las keys se guardan en el servidor (data/settings.json). También se pueden definir en .env.local.
            </p>

            {KEY_FIELDS.map((field) => (
              <div key={field.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">{field.label}</Label>
                  <div className="flex items-center gap-2">
                    {envKeys[field.id] && (
                      <span className="text-[10px] text-green-500 flex items-center gap-1">
                        <Check className="h-2.5 w-2.5" />
                        .env.local
                      </span>
                    )}
                    {field.helpUrl && (
                      <a
                        href={field.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-primary hover:underline"
                      >
                        Obtener key
                      </a>
                    )}
                  </div>
                </div>
                <div className="relative">
                  <Input
                    type={showKeys[field.id] ? 'text' : 'password'}
                    placeholder={envKeys[field.id] ? `Definida en .env.local` : field.placeholder}
                    value={keys[field.id] || ''}
                    onChange={(e) =>
                      setKeys((prev) => ({ ...prev, [field.id]: e.target.value }))
                    }
                    className="pr-10 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => toggleShow(field.id)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKeys[field.id] ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* OpenRouter Model Selection */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Modelo OpenRouter
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              OpenRouter da acceso a modelos de múltiples proveedores con una sola API key.
              El modelo seleccionado se usa para la reinterpretación de subtítulos.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {OPENROUTER_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setOpenrouterModel(m.id)}
                  className={`rounded-md border p-2.5 text-left text-xs transition-colors ${
                    openrouterModel === m.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/30'
                  }`}
                >
                  <div className="font-medium">{m.label}</div>
                  <div className="text-[10px] text-muted-foreground flex items-center justify-between mt-0.5">
                    <span className="font-mono truncate">{m.id}</span>
                    <span className="ml-2 text-muted-foreground/70 flex-none">{m.price}</span>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Ollama */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" />
              Ollama (local)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Para usar modelos locales sin coste ni límites. Requiere Ollama instalado.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Host</Label>
                <Input
                  placeholder="http://localhost:11434"
                  value={ollamaHost}
                  onChange={(e) => setOllamaHost(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Modelo</Label>
                <Input
                  placeholder="llama3.1"
                  value={ollamaModel}
                  onChange={(e) => setOllamaModel(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Save */}
        <div className="flex justify-end pb-6">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Guardar configuración
          </Button>
        </div>
      </main>
    </div>
  );
}
