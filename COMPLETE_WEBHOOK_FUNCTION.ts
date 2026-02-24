// COMPLETE UPDATED WEBHOOK FUNCTION
// Copy this ENTIRE file and replace your current whatsapp-webhook function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

/**
 * MULTI-SOURCE WEBHOOK HANDLER
 * This webhook now handles messages from BOTH:
 * 1. Twilio WhatsApp (FormData format)
 * 2. Baileys Bot (JSON format)
 * 
 * MULTI-HOSPITAL ROUTING:
 * Routes messages to correct hospital by matching the "To" number
 * against the `whatsapp_number` column in the hospitals table.
 */

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let from = '';
    let to = '';
    let body = '';
    let messageSid = '';
    let numMedia = 0;
    let isBaileysBot = false;

    // Detect source: Twilio (FormData) or Baileys (JSON)
    const contentType = req.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      // BAILEYS BOT - JSON format
      const jsonData = await req.json();
      from = jsonData.from || '';
      to = jsonData.to || '';
      body = jsonData.body || jsonData.message || '';
      messageSid = jsonData.messageSid || jsonData.messageId || `baileys-${Date.now()}`;
      numMedia = jsonData.numMedia || 0;
      isBaileysBot = true;
      
      console.log('[WhatsApp Webhook] Baileys Bot message detected');
    } else {
      // TWILIO - FormData format
      const formData = await req.formData();
      from = formData.get('From')?.toString() || '';
      to = formData.get('To')?.toString() || '';
      body = formData.get('Body')?.toString() || '';
      messageSid = formData.get('MessageSid')?.toString() || '';
      numMedia = parseInt(formData.get('NumMedia')?.toString() || '0');
      
      console.log('[WhatsApp Webhook] Twilio message detected');
    }

    console.log(`[WhatsApp Webhook] Message from ${from} to ${to}: ${body}`);

    // Extract phone numbers (remove 'whatsapp:' prefix if present)
    const patientPhone = from.replace('whatsapp:', '').replace('+', '');
    const hospitalWhatsApp = to.replace('whatsapp:', '').replace('+', '');

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // Find hospital by WhatsApp number
    let hospitalId: string | null = null;
    let hospitalName: string = 'the hospital';
    
    // Try to find hospital by whatsapp_number (with or without + prefix)
    const { data: hospital } = await supabase
      .from('hospitals')
      .select('id, name, whatsapp_enabled, whatsapp_number')
      .or(`whatsapp_number.eq.${hospitalWhatsApp},whatsapp_number.eq.+${hospitalWhatsApp}`)
      .eq('whatsapp_enabled', true)
      .single();

    if (hospital) {
      hospitalId = hospital.id;
      hospitalName = hospital.name;
      console.log(`[WhatsApp Webhook] Matched hospital: ${hospital.name} (${hospitalId})`);
    } else {
      // Fallback: get the first hospital with whatsapp enabled
      const { data: fallbackHospital } = await supabase
        .from('hospitals')
        .select('id, name')
        .eq('organization_type', 'hospital')
        .limit(1)
        .single();
      
      if (fallbackHospital) {
        hospitalId = fallbackHospital.id;
        hospitalName = fallbackHospital.name;
        console.log(`[WhatsApp Webhook] Using fallback hospital: ${fallbackHospital.name}`);
      }
    }

    if (!hospitalId) {
      console.error('[WhatsApp Webhook] No hospital found for WhatsApp number:', hospitalWhatsApp);
      
      // Return appropriate format based on source
      if (isBaileysBot) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Service not configured',
            response: 'Sorry, this service is not configured. Please contact the hospital directly.'
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, this service is not configured. Please contact the hospital directly.</Message></Response>',
          { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } }
        );
      }
    }

    // Find or create conversation session
    let conversation;
    
    // Look for active conversation (not completed, within last 2 hours)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    
    const { data: existingConversation } = await supabase
      .from('whatsapp_conversations')
      .select('*')
      .eq('hospital_id', hospitalId)
      .eq('patient_phone', patientPhone)
      .neq('conversation_state', 'completed')
      .gte('last_message_at', twoHoursAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existingConversation) {
      conversation = existingConversation;
      console.log('[WhatsApp Webhook] Found existing conversation:', conversation.id);
    } else {
      // Create new conversation
      const { data: newConversation, error: createError } = await supabase
        .from('whatsapp_conversations')
        .insert({
          hospital_id: hospitalId,
          patient_phone: patientPhone,
          conversation_state: 'greeting',
          transcript: []
        })
        .select()
        .single();

      if (createError) {
        console.error('[WhatsApp Webhook] Error creating conversation:', createError);
        throw createError;
      }
      
      conversation = newConversation;
      console.log('[WhatsApp Webhook] Created new conversation:', conversation.id);
    }

    // Add incoming message to transcript
    const updatedTranscript = [
      ...(conversation.transcript || []),
      {
        role: 'patient',
        content: body,
        timestamp: new Date().toISOString(),
        messageSid
      }
    ];

    // Update conversation with new message
    await supabase
      .from('whatsapp_conversations')
      .update({
        transcript: updatedTranscript,
        last_message_at: new Date().toISOString()
      })
      .eq('id', conversation.id);

    // Call AI conversation handler
    const aiResponse = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-ai-conversation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        conversationId: conversation.id,
        patientPhone,
        hospitalId,
        hospitalName,
        message: body,
        transcript: updatedTranscript,
        conversationState: conversation.conversation_state,
        existingSymptoms: conversation.collected_symptoms,
        existingTriageLevel: conversation.triage_level,
        existingPatientName: conversation.patient_name
      })
    });

    const aiResult = await aiResponse.json();
    console.log('[WhatsApp Webhook] AI Response:', aiResult);

    // Send response based on source
    if (isBaileysBot) {
      // For Baileys bot, we return JSON and the bot handles sending
      console.log('[WhatsApp Webhook] Returning response to Baileys bot');
    } else {
      // For Twilio, send via Twilio API
      await sendWhatsAppMessageViaTwilio(
        hospitalWhatsApp,
        patientPhone,
        aiResult.response
      );
    }

    // Update conversation with AI response
    const finalTranscript = [
      ...updatedTranscript,
      {
        role: 'assistant',
        content: aiResult.response,
        timestamp: new Date().toISOString()
      }
    ];

    const newState = aiResult.newState || conversation.conversation_state;
    const collectedSymptoms = aiResult.symptoms || conversation.collected_symptoms;
    const triageLevel = aiResult.triageLevel || conversation.triage_level;
    const patientName = aiResult.patientName || conversation.patient_name;
    const urgencyScore = aiResult.urgencyScore || conversation.urgency_score;
    const firstAidGiven = aiResult.firstAid || conversation.first_aid_given;
    const preferredDate = aiResult.preferredDate || null;
    const preferredTime = aiResult.preferredTime || null;

    await supabase
      .from('whatsapp_conversations')
      .update({
        transcript: finalTranscript,
        conversation_state: newState,
        collected_symptoms: collectedSymptoms,
        triage_level: triageLevel,
        urgency_score: urgencyScore,
        first_aid_given: firstAidGiven,
        patient_name: patientName
      })
      .eq('id', conversation.id);

    // Determine if appointment should be created
    const shouldCreateAppointment = (
      !conversation.appointment_created && (
        aiResult.createAppointment === true ||
        (
          collectedSymptoms &&
          triageLevel &&
          triageLevel !== 'CRITICAL'
        )
      )
    );

    if (shouldCreateAppointment) {
      console.log('[WhatsApp Webhook] Triggering appointment creation...');
      
      await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-create-appointment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          conversationId: conversation.id,
          hospitalId,
          patientPhone,
          patientName: patientName || 'WhatsApp Patient',
          symptoms: collectedSymptoms,
          triageLevel: triageLevel,
          urgencyScore: urgencyScore,
          firstAidGiven: firstAidGiven,
          preferredDate: preferredDate,
          preferredTime: preferredTime,
          transcript: finalTranscript
        })
      });
    }

    // Return appropriate response based on source
    if (isBaileysBot) {
      // Return JSON for Baileys bot
      return new Response(
        JSON.stringify({ 
          success: true, 
          response: aiResult.response,
          conversationId: conversation.id,
          conversationState: newState
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      // Return TwiML for Twilio (empty since message already sent via API)
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } }
      );
    }

  } catch (error) {
    console.error('[WhatsApp Webhook] Error:', error);
    
    // Return appropriate error format
    const contentType = req.headers.get('content-type') || '';
    const isBaileysBot = contentType.includes('application/json');
    
    if (isBaileysBot) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: error.message,
          response: 'Sorry, there was an error processing your message. Please try again.'
        }),
        { 
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    } else {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, there was an error processing your message. Please try again.</Message></Response>',
        { headers: { ...corsHeaders, 'Content-Type': 'text/xml' } }
      );
    }
  }
});

async function sendWhatsAppMessageViaTwilio(from: string, to: string, body: string): Promise<any> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log('[WhatsApp Webhook] Twilio credentials not configured, skipping Twilio send');
    return null;
  }

  const accountSid = TWILIO_ACCOUNT_SID;
  const authToken = TWILIO_AUTH_TOKEN;
  
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  
  const formData = new URLSearchParams();
  formData.append('From', `whatsapp:+${from}`);
  formData.append('To', `whatsapp:+${to}`);
  formData.append('Body', body);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  const result = await response.json();
  console.log('[WhatsApp Webhook] Twilio send result:', result);
  return result;
}
